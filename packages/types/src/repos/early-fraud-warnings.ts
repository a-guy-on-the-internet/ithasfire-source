/**
 * Stripe Radar early fraud warnings (EFW).
 *
 * The card issuer has told Stripe a charge is probably fraudulent — usually
 * days before the chargeback itself. `actionable` is Stripe's flag (false once
 * the charge is disputed or fully refunded); `resolvedAt` / `resolution` are
 * OUR record of why the warning stopped mattering.
 */

export type EarlyFraudWarningResolution = "REFUNDED" | "DISPUTED" | "IGNORED";

export interface EarlyFraudWarningRecord {
  id: string;
  stripeEfwId: string;
  stripeChargeId: string;
  paymentIntentId: string | null;
  orderId: string | null;
  ownerOrgId: string | null;
  ownerHumanId: string | null;
  /** Stripe `fraud_type` verbatim — free string, Stripe adds values. */
  fraudType: string;
  actionable: boolean;
  /** Stripe's `created` on the EFW object. */
  stripeCreatedAt: Date;
  resolvedAt: Date | null;
  resolution: EarlyFraudWarningResolution | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertEarlyFraudWarningInput {
  stripeEfwId: string;
  stripeChargeId: string;
  paymentIntentId?: string | null;
  orderId?: string | null;
  ownerOrgId?: string | null;
  ownerHumanId?: string | null;
  fraudType: string;
  actionable: boolean;
  stripeCreatedAt: Date;
}

export interface MarkEarlyFraudWarningResolvedInput {
  id: string;
  resolution: EarlyFraudWarningResolution;
  resolvedAt: Date;
}

export interface ListActionableEarlyFraudWarningsInput {
  /** Hard cap on rows returned (defaults to, and never exceeds, 200). */
  limit?: number;
}

/**
 * The slice of an EFW that read models (dispute desk row, admin order) carry:
 * enough to render "issuer flagged this as <type> on <date>" and nothing
 * that would let a surface re-derive ops' resolution state.
 */
export interface EarlyFraudWarningSummary {
  fraudType: string;
  stripeCreatedAt: Date;
}
