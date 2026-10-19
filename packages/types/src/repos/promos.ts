export type PromoStatus = "ACTIVE" | "ARCHIVED";

export type PromoKind = "PERCENT" | "AMOUNT";

export type PromoScope = "GLOBAL" | "ORG" | "EVENT" | "TICKET_TYPE" | "HUMAN";

export type PromoHoldStatus = "PENDING" | "CONFIRMED" | "RELEASED";

export interface PromoRecord {
  id: string;
  code: string;
  codeNormalized: string;
  status: PromoStatus;
  kind: PromoKind;
  scope: PromoScope;
  scopeId?: string | null;
  value: number;
  /** ISO 4217 currency code (lowercase), e.g. "usd", "eur", "jpy". */
  currency: string;
  minOrderCents: number;
  maxRedemptions?: number | null;
  maxRedemptionsPerHuman?: number | null;
  maxDiscountCents?: number | null;
  stackable: boolean;
  /** When true, the code may be auto-applied from a shareable URL. */
  isPublic: boolean;
  startsAt?: Date | null;
  endsAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * ONE ledger, TWO sources.
 *
 * A discount reaches an order either as a typed/URL promo code (`promoId`) or
 * as a membership entitlement (`membershipBenefitId`). EXACTLY one is set —
 * enforced in Postgres by the `*_source_xor` CHECK constraints, not merely by
 * convention here. Everything downstream of creation (confirm, release,
 * `amountDiscountCents` reporting) is source-agnostic.
 */
export interface PromoHoldRecord {
  id: string;
  promoId: string | null;
  membershipBenefitId: string | null;
  orderId: string;
  humanId: string;
  idempotencyKey: string;
  code: string;
  amountDiscountCents: number;
  status: PromoHoldStatus;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PromoRedemptionRecord {
  id: string;
  promoId: string | null;
  membershipBenefitId: string | null;
  orderId: string;
  humanId: string;
  code: string;
  amountDiscountCents: number;
  redeemedAt: Date;
}
/** @deprecated Use PromoRedemptionRecord */

export interface PromoRedemptionStats {
  totalRedemptions: number;
  redemptionsForHuman: number;
}
/** @deprecated Use PromoRedemptionStats */

/**
 * Exactly one of `promoId` / `membershipBenefitId` — a union rather than two
 * optional fields, so "both" and "neither" are unrepresentable at the call
 * site instead of only being caught by the DB CHECK.
 */
export type PromoHoldSource =
  | { promoId: string; membershipBenefitId?: never }
  | { membershipBenefitId: string; promoId?: never };

export type CreatePromoHoldInput = PromoHoldSource & {
  orderId: string;
  humanId: string;
  idempotencyKey: string;
  /**
   * Normalized promo code for a typed application; a stable `benefit:{id}`
   * marker for a membership grant (benefits have no code, by design).
   */
  code: string;
  amountDiscountCents: number;
  expiresAt: Date;
};
/** @deprecated Use CreatePromoHoldInput */

export interface FindActivePromosInput {
  codes: string[];
  now: Date;
  /** When true, restrict the lookup to `isPublic = true` codes (URL-applied flow). */
  publicOnly?: boolean;
}
/** @deprecated Use FindActivePromosInput */

export interface PromoRedemptionStatsInput {
  promoId: string;
  humanId?: string;
}
/** @deprecated Use PromoRedemptionStatsInput */

export interface ConfirmPromoHoldsInput {
  orderId: string;
  confirmedAt: Date;
}
/** @deprecated Use ConfirmPromoHoldsInput */

// ── CRUD types ───────────────────────────────────────────────────────────────

export interface CreatePromoInput {
  code: string;
  kind: PromoKind;
  value: number;
  /** ISO 4217 currency code (lowercase). Defaults to "usd" in the adapter. */
  currency?: string;
  scope: PromoScope;
  scopeId?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  maxRedemptions?: number | null;
  maxRedemptionsPerHuman?: number | null;
  minOrderCents?: number;
  maxDiscountCents?: number | null;
  stackable?: boolean;
  isPublic?: boolean;
}
/** @deprecated Use CreatePromoInput */

export interface UpdatePromoInput {
  id: string;
  code?: string;
  kind?: PromoKind;
  value?: number;
  currency?: string;
  startsAt?: Date | null;
  endsAt?: Date | null;
  maxRedemptions?: number | null;
  maxRedemptionsPerHuman?: number | null;
  minOrderCents?: number;
  maxDiscountCents?: number | null;
  stackable?: boolean;
  isPublic?: boolean;
  status?: PromoStatus;
}
/** @deprecated Use UpdatePromoInput */

export interface ListPromosByScopeInput {
  scope?: PromoScope;
  scopeId?: string | null;
  status?: PromoStatus;
  limit: number;
  offset: number;
}
/** @deprecated Use ListPromosByScopeInput */

export interface ListPromosByScopeResult {
  items: PromoRecord[];
  total: number;
}
/** @deprecated Use ListPromosByScopeResult */

export interface PromoWithStats extends PromoRecord {
  totalRedemptions: number;
}
/** @deprecated Use PromoWithStats */
