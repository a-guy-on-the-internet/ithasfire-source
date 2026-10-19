export type MembershipInterval = "MONTH" | "YEAR";
export type MembershipTierStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";

/** Discount maths a benefit carries itself. Mirrors `PromoKind`'s semantics. */
export type MembershipDiscountKind = "AMOUNT" | "PERCENT";

export interface MembershipTierRecord {
  id: string;
  /** Exactly one of these is set. */
  ownerOrgId: string | null;
  ownerHumanId: string | null;
  name: string;
  description: string | null;
  /** The owner's own statement of what members get. Never our characterisation. */
  benefitsDescription: string | null;
  priceCents: number;
  currency: string;
  interval: MembershipInterval;
  /** Null until the tier is published — Stripe objects are minted lazily. */
  stripeProductId: string | null;
  stripePriceId: string | null;
  status: MembershipTierStatus;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMembershipTierInput {
  ownerOrgId?: string | null;
  ownerHumanId?: string | null;
  name: string;
  description?: string | null;
  benefitsDescription?: string | null;
  priceCents: number;
  currency: string;
  interval: MembershipInterval;
  sortOrder?: number;
}

/**
 * A tier's DISCOUNT benefit, as read at checkout by `resolveMemberBenefits`.
 *
 * The discount terms live HERE, on the benefit — there is no Promo behind it
 * and therefore no code, no campaign window, and nothing that can expire out
 * from under the tier. Terms are mandatory at the column level, so there is no
 * "incomplete benefit" state to defend against.
 */
export interface MembershipTierBenefitRecord {
  id: string;
  tierId: string;
  discountKind: MembershipDiscountKind;
  /** Cents off (AMOUNT) or percent 1–100 (PERCENT). */
  discountValue: number;
  /** Optional clamp on the computed discount, integer cents. */
  maxDiscountCents: number | null;
  /** Optional narrowing: when set, the benefit only applies to events with this category. */
  categoryId: string | null;
  /** Optional narrowing: when set, the benefit only applies to events at this place. */
  placeId: string | null;
  /** Owner override for the checkout line label. Null = generated label. */
  label: string | null;
}

/**
 * Per-owner tier/member rollup for the platform standing overview
 * (/platform/memberships). Exactly one of the owner ids is set per row.
 */
export interface MembershipOwnerTierStats {
  ownerOrgId: string | null;
  ownerHumanId: string | null;
  /** Tiers in ANY status (DRAFT / ACTIVE / ARCHIVED). */
  tierCount: number;
  /** Tiers currently ACTIVE (publicly joinable). */
  activeTierCount: number;
  /** Memberships whose status is in the caller-supplied `memberStatuses`. */
  memberCount: number;
}

export interface MembershipTiersRepo {
  create(input: CreateMembershipTierInput): Promise<MembershipTierRecord>;
  findById(id: string): Promise<MembershipTierRecord | null>;

  /**
   * Tiers by id, any status. One query — `resolveMemberBenefits` needs each
   * granting tier's OWNER to derive the grant's scope, and a per-tier
   * `findById` fan-out inside the checkout transaction is the N+1 this avoids.
   * Missing ids are simply absent from the result.
   */
  listByIds(ids: string[]): Promise<MembershipTierRecord[]>;

  listForOwner(input: {
    ownerOrgId?: string | null;
    ownerHumanId?: string | null;
    statuses?: MembershipTierStatus[];
  }): Promise<MembershipTierRecord[]>;

  update(input: {
    id: string;
    name?: string;
    description?: string | null;
    benefitsDescription?: string | null;
    /**
     * Guarded by the use case: only writable while the tier is an unpublished
     * DRAFT with no subscribers — Stripe Prices are immutable, so a published
     * tier's price change is archive-and-replace, never an edit.
     */
    priceCents?: number;
    sortOrder?: number;
    status?: MembershipTierStatus;
  }): Promise<MembershipTierRecord>;

  attachStripeIds(input: {
    id: string;
    stripeProductId: string;
    stripePriceId: string;
  }): Promise<MembershipTierRecord>;

  /**
   * How many memberships reference this tier in any state.
   *
   * Gates the price-immutability rule: Stripe Prices cannot be edited, so once
   * a tier has ever had a subscriber its `priceCents` is frozen and a change
   * means archive-and-replace.
   */
  countSubscribers(tierId: string): Promise<number>;

  /**
   * Every owner (org or human) with at least one tier in any status, with
   * tier counts and a member count restricted to `memberStatuses` (callers
   * pass a set from `membership-status.ts` — the adapter takes raw strings so
   * it does not import core). ONE query, grouped in the adapter — never
   * per-owner fan-out.
   */
  listOwnersWithTiers(input: {
    memberStatuses: string[];
  }): Promise<MembershipOwnerTierStats[]>;

  /**
   * LIVE benefits attached to the given tiers, for benefit resolution at
   * ticket checkout. Retired rows (`archivedAt` set) are excluded — a retired
   * benefit grants nothing, which is what makes retirement externally
   * identical to the hard delete it replaced. Ordered deterministically so
   * downstream admission does not flap between checkouts.
   */
  listBenefitsForTiers(tierIds: string[]): Promise<MembershipTierBenefitRecord[]>;

  /**
   * Create a DISCOUNT benefit on a tier. Term validation and tier ownership
   * are the USE CASE's job — the adapter only persists.
   */
  createBenefit(input: {
    tierId: string;
    discountKind: MembershipDiscountKind;
    discountValue: number;
    maxDiscountCents?: number | null;
    categoryId?: string | null;
    placeId?: string | null;
    label?: string | null;
  }): Promise<MembershipTierBenefitRecord>;

  /**
   * Edit a benefit's terms in place.
   *
   * `discountKind` and `discountValue` move TOGETHER, deliberately: they are
   * validated as a pair (`assertBenefitTerms` — PERCENT is 1–100, AMOUNT is
   * ≥ 1¢), so a caller allowed to change one alone could turn `PERCENT 50`
   * into `PERCENT 5000` without ever failing validation. Everything else is
   * independently optional.
   */
  updateBenefit(input: {
    id: string;
    discountKind: MembershipDiscountKind;
    discountValue: number;
    maxDiscountCents?: number | null;
    categoryId?: string | null;
    placeId?: string | null;
    label?: string | null;
  }): Promise<MembershipTierBenefitRecord>;

  /** A single LIVE benefit row, or null. Retired rows resolve to null. */
  findBenefitById(id: string): Promise<MembershipTierBenefitRecord | null>;

  /**
   * RETIRE a benefit — a soft delete, despite the name kept for the caller's
   * sake (`removeTierBenefit`'s contract is unchanged: the benefit stops
   * granting and disappears from every admin read).
   *
   * Not a DELETE, because the PromoRedemption rows a benefit produced are the
   * platform's record of granted margin. Hard-deleting one erased that history
   * from the owner's order detail AND from platform staff views, from an
   * ordinary product action with no destructive-action warning.
   */
  deleteBenefit(input: { id: string; archivedAt: Date }): Promise<void>;
}
