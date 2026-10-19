import type {
  GetPayeeBySubjectInput,
  PayeeRecord,
  PayeeStatus,
  PayeeSubjectType,
  SyncPayeeCapabilitiesInput,
  SyncPayeeCapabilitiesOutcome,
  UpdatePayeeResaleFinanceStateInput,
} from "@th/types/repos/payees";

export interface PayeesRepo {
  getById(id: string): Promise<PayeeRecord | null>;
  /**
   * Batch-fetch payees by ID.
   * Returns records only for IDs that exist; missing IDs are silently omitted.
   */
  getByIds(ids: string[]): Promise<PayeeRecord[]>;
  getBySubject(subject: GetPayeeBySubjectInput): Promise<{ id: string } | null>;
  /**
   * Look up a Payee by its Stripe Connect account id. Used by the
   * `account.updated` webhook path to resolve the payee (and its subject) when
   * an account becomes ACTIVE, so we can auto-provision the entity's default
   * payout terms. Returns `null` when no payee references the account.
   */
  getByStripeAccountId(stripeAccountId: string): Promise<PayeeRecord | null>;
  /**
   * Write capability state, subject to the RESTRICTED and ordering guards.
   * Returns what it did — a `skipped_*` outcome means NOTHING was written and
   * the caller must not report success.
   */
  syncCapabilities(
    input: SyncPayeeCapabilitiesInput,
  ): Promise<SyncPayeeCapabilitiesOutcome>;
  /**
   * Payees due a capability re-read from Stripe, stalest first.
   *
   * Backstop for the reconcile job. `account.updated` is the only push-based
   * writer of capability state, so anything it loses stays wrong until someone
   * happens to load a page that triggers the live-read write-back. This is the
   * pull side of that.
   *
   * Ordered by `capabilitiesSyncedAt ASC NULLS FIRST`, which makes the column
   * a self-advancing cursor: a reconciled row is stamped with "now" and sorts
   * to the back, so successive runs walk the whole population without a
   * separate offset. Excludes RESTRICTED (the repo refuses to promote those, so
   * a Stripe call could not change anything) and rows with no Stripe account.
   */
  listForCapabilityReconcile(input: { limit: number }): Promise<PayeeRecord[]>;
  /**
   * How many payees are RESTRICTED but still carry a Stripe account.
   *
   * Deliberately separate from the sweep. These cannot be healed — re-onboarding
   * does not clear RESTRICTED — so per-row alerting would be recurring noise,
   * but the count needs to be visible because each one is an org that can
   * neither publish nor be paid.
   */
  countRestrictedWithStripeAccount(): Promise<number>;
  /**
   * Create or update a Payee for a subject, linking it to a Stripe Connect account.
   * Used during the Stripe Connect onboarding flow.
   */
  upsertForSubject(input: {
    subjectType: PayeeSubjectType;
    subjectId: string;
    /**
     * Stripe Connect account id. Optional / null when creating a Payee
     * placeholder before Connect onboarding (e.g. a payout-line target
     * for a payee whose Connect onboarding hasn't started yet). The
     * record stays in PENDING with `payoutsEnabled = false` until the
     * Connect flow links the real account id.
     */
    stripeAccountId?: string | null;
  }): Promise<PayeeRecord>;

  /**
   * Mark a payee as deauthorized (Connect account revoked).
   * Sets status=RESTRICTED, payoutsEnabled=false, chargesEnabled=false.
   * Returns the payee record (or null if no payee matches the Stripe account).
   */
  markDeauthorized(stripeAccountId: string): Promise<PayeeRecord | null>;
  updateResaleFinanceState(
    input: UpdatePayeeResaleFinanceStateInput,
  ): Promise<PayeeRecord>;
}

export type {
  GetPayeeBySubjectInput,
  PayeeRecord,
  PayeeStatus,
  PayeeSubjectType,
  SyncPayeeCapabilitiesInput,
  SyncPayeeCapabilitiesOutcome,
  UpdatePayeeResaleFinanceStateInput,
} from "@th/types/repos/payees";
