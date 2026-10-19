export type FeePolicyScopeType = "GLOBAL" | "ORG" | "EVENT";
export type FeePolicyStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";
export type FeeMode = "ABSORB" | "PASS_THROUGH";

export interface FeePolicyRecord {
  id: string;
  scopeType: FeePolicyScopeType;
  scopeId: string | null;
  status: FeePolicyStatus;
  version: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  buyerFeePct: number;
  maxFeeCents: number | null;
  minFeeCents: number;
  maxPlatformFeeCents: number | null;
  platformFixedCents: number;
  feeMode: FeeMode;
  processsorFeePct: number;
  processorFixedCents: number;
  payoutPct: number;
  payoutFixedCents: number;
  monthlyPayoutCents: number;
  payoutMinimumCents: number;
  /**
   * Stripe's monthly ACTIVE-connected-account fee in cents (200 = $2), withheld
   * from a payout in months where that payout is the only reason the account
   * went active. 0 = recovery disabled.
   *
   * Distinct from {@link monthlyPayoutCents} on purpose: that one is a ticket
   * PRICING input (it rides in `payoutTermsPolicySchema` next to `payoutPct`),
   * this one is a payout-time withholding. See `finance.prisma` for the full
   * argument.
   */
  connectAccountFeeCents: number;
}

export interface ResolveFeePolicyInput {
  scopeType: FeePolicyScopeType;
  scopeId: string | null;
  at: Date;
}
