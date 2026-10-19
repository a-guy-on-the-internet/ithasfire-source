import type {
  EarlyFraudWarningRecord,
  ListActionableEarlyFraudWarningsInput,
  MarkEarlyFraudWarningResolvedInput,
  UpsertEarlyFraudWarningInput,
} from "@th/types/repos/early-fraud-warnings";

export interface EarlyFraudWarningsRepo {
  /**
   * Idempotent on `stripeEfwId`. An update never clears a stored
   * `orderId` / owner — a later, thinner Stripe payload must not unlink a
   * warning the first delivery managed to link.
   */
  upsertFromStripe(
    input: UpsertEarlyFraudWarningInput,
  ): Promise<EarlyFraudWarningRecord>;

  findByStripeEfwId(stripeEfwId: string): Promise<EarlyFraudWarningRecord | null>;

  /**
   * The ops queue: `actionable = true AND resolvedAt IS NULL`, newest Stripe
   * warning first. Capped at 200.
   */
  listActionable(
    input?: ListActionableEarlyFraudWarningsInput,
  ): Promise<EarlyFraudWarningRecord[]>;

  /**
   * Compare-and-set: stamps `resolvedAt` / `resolution` ONLY on a row that is
   * still unresolved. Returns null when the row is unknown or already
   * resolved, so a replayed webhook never overwrites the first resolution
   * (a DISPUTED warning must not flip to REFUNDED when the post-dispute
   * refund event arrives).
   */
  markResolved(
    input: MarkEarlyFraudWarningResolvedInput,
  ): Promise<EarlyFraudWarningRecord | null>;

  /** Newest UNRESOLVED warning on the order, or null. */
  findActiveForOrder(orderId: string): Promise<EarlyFraudWarningRecord | null>;

  /**
   * Newest warning on the order regardless of resolution — the dispute desk
   * wants "we were warned" even after the warning resolved as DISPUTED.
   */
  findLatestForOrder(orderId: string): Promise<EarlyFraudWarningRecord | null>;

  /** Newest UNRESOLVED warning on the charge, or null. */
  findActiveByStripeChargeId(
    stripeChargeId: string,
  ): Promise<EarlyFraudWarningRecord | null>;
}

export type {
  EarlyFraudWarningRecord,
  EarlyFraudWarningResolution,
  EarlyFraudWarningSummary,
  ListActionableEarlyFraudWarningsInput,
  MarkEarlyFraudWarningResolvedInput,
  UpsertEarlyFraudWarningInput,
} from "@th/types/repos/early-fraud-warnings";
