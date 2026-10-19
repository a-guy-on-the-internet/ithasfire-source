export type PayeeSubjectType = "HUMAN" | "ORGANIZATION";

export type PayeeStatus = "PENDING" | "ACTIVE" | "RESTRICTED";

export interface PayeeRecord {
  id: string;
  subjectType: PayeeSubjectType;
  subjectId: string;
  stripeAccountId: string | null;
  status: PayeeStatus;
  payoutsEnabled: boolean;
  chargesEnabled: boolean;
  defaultCurrency: string;
  resaleNegativeBalanceCents: number;
  resaleNegativeBalanceOpenedAt: Date | null;
  resaleNegativeBalanceAgingStartsAt: Date | null;
  resalePayoutBlockReason: string | null;
  resalePayoutBlockedAt: Date | null;
}

export interface GetPayeeBySubjectInput {
  type: PayeeSubjectType;
  id: string;
}

/**
 * What `syncCapabilities` actually did.
 *
 * Two of these mean the write was DROPPED, and both were previously silent —
 * the caller logged a success it never got. `skipped_restricted` in particular
 * reproduces the original publish-gate outage through a different door: a payee
 * deauthorized and then re-onboarded stays RESTRICTED, so neither the webhook
 * nor the live-read write-back can ever promote it.
 */
export type SyncPayeeCapabilitiesOutcome =
  | "applied"
  | "skipped_restricted"
  | "skipped_stale"
  /**
   * No Payee row exists for this Stripe account. Payee rows are minted by
   * onboarding (`initiate-onboarding` → `upsertForSubject`) BEFORE Stripe can
   * emit events for the account, so an unknown id here is foreign — a
   * `stripe trigger account.updated` fixture, another consumer of a shared
   * test key, or an account whose row was deliberately removed. The repo used
   * to CREATE a placeholder row here (`subjectType: "HUMAN", subjectId: ""`,
   * the removed `"created"` outcome): unfindable by subject, re-read from
   * Stripe by every nightly reconcile forever, and — because
   * `[subjectType, subjectId]` is unique — the SECOND unknown account P2002'd
   * into a permanent DLQ entry.
   */
  | "skipped_unknown_account"
  /** Programming error: called with no Stripe account id. Never routine. */
  | "skipped_no_account";

export interface SyncPayeeCapabilitiesInput {
  stripeAccountId: string;
  status: PayeeStatus;
  payoutsEnabled: boolean;
  chargesEnabled: boolean;
  defaultCurrency: string;
  requirements: unknown;
  /**
   * When the source system observed this state (Stripe `event.created` for a
   * webhook, "now" for a live read).
   *
   * Stripe does not guarantee webhook ordering and retries arrive late, so the
   * write is conditional on this being >= the last-applied observation. Without
   * it a stale "still pending" delivery can permanently clobber a good "now
   * active" write and leave an org unable to publish.
   *
   * Comparison is `>=`, and `event.created` is second-granular, so two distinct
   * events in the same second are NOT ordered relative to each other. See the
   * guard in the Prisma payees adapter for why that trade is deliberate.
   */
  observedAt: Date;
}

export interface UpdatePayeeResaleFinanceStateInput {
  payeeId: string;
  resaleNegativeBalanceCents?: number;
  resaleNegativeBalanceOpenedAt?: Date | null;
  resaleNegativeBalanceAgingStartsAt?: Date | null;
  resalePayoutBlockReason?: string | null;
  resalePayoutBlockedAt?: Date | null;
}
