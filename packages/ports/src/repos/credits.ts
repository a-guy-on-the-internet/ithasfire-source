import type {
  UserCreditRecord,
  UserCreditRedemptionRecord,
  UserCreditSourceType,
} from "@th/types";

export interface GrantUserCreditInput {
  humanId: string;
  amountCents: number;
  /** ISO 4217 currency code (lowercase), e.g. "usd". */
  currency: string;
  reason: string;
  sourceType: UserCreditSourceType;
  grantedByHumanId?: string | null;
  sourceRef?: string | null;
  expiresAt?: Date | null;
}

export interface ListActiveCreditsInput {
  humanId: string;
  /** ISO 4217 currency code (lowercase). Only credits matching this currency. */
  currency: string;
}

export interface RecordCreditRedemptionInput {
  creditId: string;
  orderId: string;
  amountCents: number;
}

export interface RedeemCreditConditionalInput {
  creditId: string;
  /**
   * The amount we would like to debit. The adapter applies
   * `min(balance, requestedCents)` atomically and conditionally, so a
   * concurrent checkout can never drive the balance below zero or spend the
   * same cents twice.
   */
  requestedCents: number;
}

export interface RedeemCreditConditionalResult {
  /**
   * Cents actually debited from the credit. `0` means the credit no longer
   * has spendable funds (drained by a concurrent checkout, expired, or
   * already fully redeemed) and the caller must NOT count it as applied.
   */
  appliedCents: number;
  /** Residual balance after the debit. */
  balanceAfterCents: number;
}

export interface ReleaseCreditsForOrderOptions {
  /**
   * The instant the expiry check is made against, from the caller's
   * `ClockPort` where one exists. Falls back to the adapter's wall clock. A
   * BOUND instant keeps the release consistent with the JS-Date predicate
   * `listActiveForHuman` reads by, instead of the database's NOW().
   */
  now?: Date;
}

export interface ReleaseCreditsForOrderResult {
  /** Total cents restored across every credit the order had spent. */
  releasedCents: number;
  /** Credits whose balance was restored by this call (empty on a replay). */
  creditIds: string[];
}

export interface CreditsRepo {
  /** Create a new platform-funded credit for a human. */
  grant(input: GrantUserCreditInput): Promise<UserCreditRecord>;

  /**
   * Active, spendable credits for a human in a given currency. Ordered
   * expiresAt ASC NULLS LAST, createdAt ASC so soonest-to-expire is consumed
   * first (FIFO against expiry).
   */
  listActiveForHuman(
    input: ListActiveCreditsInput,
  ): Promise<UserCreditRecord[]>;

  /** All credits for a human (any status), newest first — for account history. */
  listAllForHuman(humanId: string): Promise<UserCreditRecord[]>;

  /** Redemption rows for a human's credits — for account history. */
  listRedemptionsForHuman(
    humanId: string,
  ): Promise<UserCreditRedemptionRecord[]>;

  /**
   * Anti-abuse / idempotency guard: returns an existing credit with the same
   * (sourceType, sourceRef) for this human, if any. NULL sourceRef never matches.
   */
  findBySource(input: {
    humanId: string;
    sourceType: UserCreditSourceType;
    sourceRef: string;
  }): Promise<UserCreditRecord | null>;

  /**
   * Atomically and conditionally debit a credit's balance by up to
   * `requestedCents`, returning the amount actually applied. Implemented as a
   * single `UPDATE ... WHERE balance > 0` so two concurrent checkouts racing
   * on the same credit can never double-spend it or push it negative — the
   * second writer sees the post-debit balance. Sets status to REDEEMED when
   * the balance reaches 0. Does NOT write a redemption row; the caller pairs
   * this with `recordRedemption` (which needs the order to exist first).
   */
  redeemConditional(
    input: RedeemCreditConditionalInput,
  ): Promise<RedeemCreditConditionalResult>;

  /**
   * Write a redemption row recording that `amountCents` of a credit was
   * applied to an order. Idempotent on (creditId, orderId): if a redemption
   * already exists it is returned unchanged. This records the link only — the
   * balance debit is performed separately by `redeemConditional` within the
   * same transaction.
   */
  recordRedemption(
    input: RecordCreditRedemptionInput,
  ): Promise<UserCreditRedemptionRecord>;

  /**
   * Undo every redemption on a PENDING order that died unpaid, so the credit
   * `redeemConditional` SPENT at checkout comes back. For each redemption on
   * the order that is still applied (`releasedAt IS NULL` and not already
   * reversed by a refund), adds `amountCents` back to the credit's balance,
   * returns a REDEEMED credit to ACTIVE — or to EXPIRED if its `expiresAt`
   * has passed, mirroring the `listActiveForHuman` predicate — and stamps
   * the redemption `releasedAt`. One statement, credit rows locked
   * `FOR UPDATE` in the same order `listActiveForHuman` spends them, so a
   * replay (reaper racing a buyer release) is a no-op and a concurrent
   * `redeemConditional` walking the same credits serialises behind it
   * instead of cycling.
   *
   * Cancel paths ONLY. A SUCCEEDED order's credit was genuinely consumed;
   * restoring it on refund is refund policy, not a hold release.
   */
  releaseForOrder(
    orderId: string,
    opts?: ReleaseCreditsForOrderOptions,
  ): Promise<ReleaseCreditsForOrderResult>;
}
