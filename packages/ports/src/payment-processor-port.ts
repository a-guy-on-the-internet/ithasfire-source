import type { PaymentCardChecks } from "@th/types/repos/orders";

import type { DisputeEvidenceFields } from "./dispute-evidence";

export type PaymentRefundStatus =
  | "pending"
  | "requires_action"
  | "succeeded"
  | "failed"
  | "canceled";

export type CreateConnectAccountInput = {
  businessType: "company" | "individual";
  individualEmail?: string;
  /** Stable provider-scoped key for retry-safe Connect account creation. */
  idempotencyKey?: string;
};

// ── Disputes (chargebacks) ──────────────────────────────────────────────

/**
 * Processor-side dispute lifecycle, in the processor's own vocabulary.
 * Mapping onto the local `DisputeStatus` (repos/disputes) is the webhook /
 * use-case layer's concern, not the port's — the two are deliberately kept
 * distinct so a live read and a webhook event describe the same thing.
 *
 * `warning_*` are early-fraud-warning / inquiry states that may never become
 * a real chargeback; `needs_response` is the only state in which evidence
 * can be submitted.
 */
export type ProcessorDisputeStatus =
  | "warning_needs_response"
  | "warning_under_review"
  | "warning_closed"
  | "needs_response"
  | "under_review"
  | "won"
  | "lost";

export type ProcessorDisputeEvidenceDetails = {
  /** Deadline for evidence submission; null once the dispute is closed. */
  dueBy: Date | null;
  /** Whether any evidence has been staged or submitted. */
  hasEvidence: boolean;
  /** True when `dueBy` passed with no submission. */
  pastDue: boolean;
  /** Number of times evidence has been submitted to the bank. */
  submissionCount: number;
};

/**
 * Normalised read of a processor dispute. Money is integer cents; currency
 * is lowercase ISO-4217; timestamps are `Date`s (processors use unix
 * seconds). `evidence` contains only the fields the processor currently
 * holds — absent keys were never set.
 */
export type ProcessorDisputeSnapshot = {
  processorDisputeId: string;
  /** The disputed charge (Stripe: ch_xxx). */
  chargeId: string;
  /** Null for charges created outside a PaymentIntent. */
  paymentIntentId: string | null;
  status: ProcessorDisputeStatus;
  amountCents: number;
  currency: string;
  /**
   * Processor reason code, passed through verbatim (Stripe: `fraudulent`,
   * `duplicate`, `product_not_received`, `subscription_canceled`, …). Kept
   * as `string` because the set is open-ended on the processor side.
   */
  reason: string;
  evidenceDetails: ProcessorDisputeEvidenceDetails;
  evidence: DisputeEvidenceFields;
};

/**
 * One currency's slice of a processor balance bucket. `currency` is lowercase
 * ISO-4217 (Stripe's own casing); `amountCents` is the minor unit, integer.
 */
export type PlatformBalanceAmount = {
  currency: string;
  amountCents: number;
};

/**
 * A read of the PLATFORM account's own money — the commingled pot that
 * `createTransfer` spends out of.
 *
 * Three buckets, deliberately kept apart because only ONE of them can fund a
 * transfer tonight:
 *
 *  - `available` — settled, spendable now. This is the number a payout batch
 *    draws down, and the one a `balance_insufficient` transfer failure is
 *    about.
 *  - `pending` — collected but not yet settled by the processor. It becomes
 *    available on the processor's own schedule, so it is runway, not cash.
 *  - `connectReserved` — held by the processor AGAINST connected-account
 *    negative balances (Stripe: `connect_reserved`). It is on our balance
 *    object but it is NOT ours to spend: Stripe has already earmarked it.
 *    Reported so a solvency read can reason about it, never added to
 *    `available`.
 *
 * Each bucket is an ARRAY, one entry per currency. Callers must compare
 * like-for-like currencies and must never sum across them.
 *
 * A currency with no money in a bucket may be absent entirely — treat a
 * missing entry as zero, not as unknown.
 */
export type PlatformBalanceSnapshot = {
  available: PlatformBalanceAmount[];
  pending: PlatformBalanceAmount[];
  connectReserved: PlatformBalanceAmount[];
};

export interface PaymentProcessorPort {
  createPaymentIntent(input: {
    amountCents: number;
    currency: string; // "usd"
    customerId?: string;
    /**
     * Used to make payment creation safe on retries.
     * Implementations should map this to the provider's idempotency mechanism.
     */
    idempotencyKey?: string;
    /**
     * Optional Connect destination account (e.g. Stripe: acct_xxx).
     * If provided, implementation should route funds to this account.
     */
    destinationAccountId?: string;
    metadata?: Record<string, string>;
    /** Optional Stripe statement descriptor suffix for buyer bank statements. */
    statementDescriptorSuffix?: string;
    /**
     * Optional human-readable summary for the processor Dashboard / exports —
     * NOT the statement descriptor above and NOT shown to the buyer (we send no
     * `receipt_email`). Build it with
     * `buildPaymentDescription` (`@th/core` → `lib/payments/payment-description`).
     */
    description?: string;
    /**
     * Defaults to true. Set false to offer card only (wallets ride on card).
     * Since the owner turned Amazon Pay and Cash App Pay off in Stripe on
     * 2026-10-13 (reversing the 2026-10-12 ruling that added them), no
     * redirect-based wallet is requested, and bank debit is the only
     * non-card method this flag can still drop. No caller sets it false
     * today.
     */
    allowRedirectPaymentMethods?: boolean;
    /**
     * Defaults to true. Set false to leave bank debits (Stripe:
     * `us_bank_account`, ACH Direct Debit) off the offered methods. With
     * `allowRedirectPaymentMethods` false the list is card-only either way.
     * The embed checkout sets it false: the owner never ruled ACH in for the
     * embed, and with Amazon Pay and Cash App off (2026-10-13) the embed
     * offers card only (Link and wallets ride on card).
     */
    allowBankDebit?: boolean;
  }): Promise<{ id: string; clientSecret: string }>;

  refundPaymentIntent(input: {
    paymentIntentId: string;
    amountCents?: number; // partial if set
    /**
     * Stripe's refund reasons, and only those: Stripe rejects any other value
     * ("other" included) with "Invalid reason", so the refund never happens.
     * Omit it when none fits.
     */
    reason?: "duplicate" | "fraudulent" | "requested_by_customer";
    /**
     * Stable provider-scoped idempotency key for refund issuance.
     * Implementations should pass this through to the payment processor.
     */
    idempotencyKey?: string;
    /**
     * Stamped on the provider refund object. Refund-creating use cases put
     * the operation identity here (`useCase`, `orderId`, the refunded
     * `orderItemIds`) so the `charge.refunded` reconciler can recover a
     * refund whose local transaction died after the provider accepted it —
     * see `buildRefundMetadata` in @th/core. Values ≤ 500 chars each.
     */
    metadata?: Record<string, string>;
  }): Promise<{ refundId: string; status: PaymentRefundStatus }>;

  /**
   * Retrieves a refund by ID, including the metadata stamped at creation.
   *
   * Used by the `charge.refunded` reconciler: the event payload does not
   * carry the refund's metadata, and the reconciler needs it to learn WHICH
   * items an interrupted internal refund paid back. Throws on lookup
   * failure; callers treat that as "metadata unavailable", never as a
   * reason to skip the ledger write.
   *
   * Optional: the not-configured stubs (`MissingStripePaymentProcessor` in
   * apps/api + apps/jobs) and the e2e stub processors spell out every
   * method, and a missing implementation here means only "cannot recover
   * item identity" — the reconciler degrades to its ledger-only path.
   */
  getRefund?(input: { refundId: string }): Promise<{
    refundId: string;
    status: PaymentRefundStatus;
    amountCents: number;
    /** Null only when the refund is not attached to a PaymentIntent. */
    paymentIntentId: string | null;
    metadata: Record<string, string>;
  }>;

  /**
   * Every refund on a PaymentIntent, with the metadata stamped at creation.
   *
   * The retry pre-flight of the refund use cases (`refundOrderItems`,
   * `refundFullOrder` — see `_shared/prior-refund-preflight.ts` in @th/core)
   * reads this AFTER claiming its idempotency key and BEFORE issuing a new
   * refund: an earlier attempt whose local transaction died after the
   * provider accepted the refund is found here by its `orderItemIds`
   * metadata and REUSED instead of refunded again. A listing failure MUST
   * throw — the caller turns it into `dependency_failed`; swallowing it
   * would re-open the double refund.
   *
   * Optional for the same reason as {@link getRefund}: the not-configured
   * stubs cannot refund at all, and the e2e stub processor moves no money.
   * A missing implementation means the pre-flight is skipped and only the
   * `charge.refunded` reconciler stands between a crash and a second refund.
   */
  listRefundsForPaymentIntent?(input: { paymentIntentId: string }): Promise<
    Array<{
      refundId: string;
      status: PaymentRefundStatus;
      amountCents: number;
      metadata: Record<string, string>;
    }>
  >;

  /**
   * Cancels a PaymentIntent that has not yet been captured/succeeded.
   *
   * Implementations should treat "already terminal" (succeeded, canceled, etc.)
   * as a graceful no-op and return `{ canceled: false }`.
   */
  cancelPaymentIntent(input: {
    paymentIntentId: string;
  }): Promise<{ canceled: boolean }>;

  /**
   * Source-of-truth processing fee for a succeeded charge.
   *
   * For Stripe, this should be derived from the PaymentIntent's latest charge
   * balance transaction fee (NOT estimated).
   */
  getProcessingFeeForPaymentIntent(input: {
    paymentIntentId: string;
  }): Promise<{ feeCents: number; currency: string }>;

  /**
   * Reads the PLATFORM account's own balance — NOT a connected account's.
   *
   * Implementations MUST issue this without the provider's connected-account
   * scoping (Stripe: no `stripeAccount` request option), because that is
   * exactly how `createTransfer` spends: an unfunded (`sourceTransaction`-less)
   * transfer draws on the platform's available balance, and this read is the
   * only way to see that pot before a transfer discovers it is empty.
   *
   * READ-ONLY and side-effect free. Nothing about calling it moves, holds or
   * reserves a cent. It is deliberately NOT a pre-flight gate on the payout
   * batch — the balance can change between the read and the transfer, so
   * gating on it would be a TOCTOU race; it exists for reporting.
   *
   * See {@link PlatformBalanceSnapshot} for why the three buckets stay
   * separate (in particular why `connectReserved` must never be folded into
   * `available`).
   */
  getPlatformBalance(): Promise<PlatformBalanceSnapshot>;

  /**
   * Moves money from the PLATFORM to a connected account.
   *
   * Implementations should surface "the platform's own balance can't cover
   * this" distinctly (a marker carrying `isInsufficientPlatformBalanceError`),
   * because it is categorically different from a per-payee failure: the whole
   * batch is affected, no payee is at fault, and the remedy is operator-side.
   * See settlements/run-batch.ts, which classifies and counts it separately.
   */
  createTransfer(input: {
    amountCents: number;
    currency: string;
    destinationAccountId: string; // Stripe acct_xxx
    metadata?: Record<string, string>;
    /**
     * Optional source transaction (charge ID) to fund this transfer.
     * When provided, the transfer is funded from this specific charge instead
     * of the platform's available balance. Required in Stripe test mode for
     * Connect transfers to succeed.
     */
    sourceTransaction?: string;
    /**
     * Stable provider-scoped idempotency key for transfer issuance.
     * Implementations should pass this through to the payment processor
     * (Stripe: request-options `idempotencyKey`) so a crash-and-retry of the
     * same logical transfer cannot issue it twice. Derive it from IMMUTABLE
     * identifiers of the transfer's contents (e.g. the settlement IDs), never
     * from retry-scoped row IDs. Providers expire these keys (Stripe: 24h) —
     * callers must not rely on it beyond that window.
     */
    idempotencyKey?: string;
  }): Promise<{ id: string }>;

  /**
   * Reverses a previously-created Connect transfer (or part of it).
   *
   * Used when refunding an order whose funds have already been transferred
   * (paid out) to a connected account. The reversal pulls funds back from the
   * connected account's Stripe balance to the platform so the buyer refund
   * doesn't come out of the platform's own pocket.
   *
   * Partial reversals are supported: pass `amountCents` to reverse only a
   * portion of the original transfer.
   */
  reverseTransfer(input: {
    /** The Stripe transfer ID (tr_xxx) to reverse. */
    transferId: string;
    /** Amount in cents to reverse. Omit for a full reversal. */
    amountCents?: number;
    metadata?: Record<string, string>;
    /**
     * Stable provider-scoped idempotency key for transfer reversal issuance.
     * Implementations should pass this through to the payment processor.
     */
    idempotencyKey?: string;
  }): Promise<{ reversalId: string }>;

  /**
   * Retrieves a Connect transfer's amount and cumulative reversed amount.
   *
   * Used as a pre-flight before `reverseTransfer`: the provider rejects a
   * reversal whose CUMULATIVE total would exceed the transfer's amount, so
   * callers issuing sequential partial reversals (e.g. two refunds on the
   * same paid-out transfer, weeks apart) read the remaining capacity
   * (`amountCents - amountReversedCents`) and cap their request at it.
   * The read is advisory — another process can reverse between the read and
   * the write, in which case `reverseTransfer` still rejects loudly.
   */
  getTransfer(input: {
    /** The Stripe transfer ID (tr_xxx) to retrieve. */
    transferId: string;
  }): Promise<{
    /** Total amount in cents originally sent on the transfer. */
    amountCents: number;
    /** Cumulative amount in cents already reversed across all reversals. */
    amountReversedCents: number;
  }>;

  /**
   * Lists the reversals already recorded against a Connect transfer.
   *
   * Used for RETRY RECOVERY: when a reversal executed at the provider but
   * the local transaction failed before its result was consumed, a retry
   * must discover that prior reversal (matched by the metadata the original
   * request stamped, e.g. `orderItemIds`) and reuse it instead of issuing —
   * or worse, skipping — a new request. Re-requesting a recomputed amount
   * under the original idempotency key is a provider idempotency error
   * (same key, different params); skipping silently turns already-returned
   * money into ledger debt.
   */
  listTransferReversals(input: {
    /** The Stripe transfer ID (tr_xxx) whose reversals to list. */
    transferId: string;
  }): Promise<
    Array<{
      reversalId: string;
      amountCents: number;
      /** Metadata stamped on the reversal at creation time (may be empty). */
      metadata: Record<string, string>;
    }>
  >;

  /**
   * Retrieves a PaymentIntent by ID.
   *
   * Used for server-side verification after client-side payment confirmation.
   * Callers should check `status` to confirm the payment actually succeeded
   * before triggering finalization.
   */
  retrievePaymentIntent(input: { paymentIntentId: string }): Promise<{
    id: string;
    status: string;
    amountReceived: number;
    currency: string;
    metadata: Record<string, string>;
  }>;

  /**
   * `retrievePaymentIntent` plus the PaymentIntent's CLIENT SECRET, for the
   * one caller that has to check a secret a guest presents
   * (`confirmEmbedGuestPayment`: the guest has no session, so holding the
   * secret is the only proof the order is theirs).
   *
   * A separate method, not a field on `retrievePaymentIntent`: that one has a
   * dozen callers (finalize, cart retirement, door-sale voids) that hand the
   * result on or could log it whole, and none of them may ever hold a bearer
   * credential. The secret is for comparison only: never log it, never put it
   * in an error's `meta` or a reporter's `extra`, never return it.
   *
   * `clientSecret` is null when the processor returns none. An unknown id is
   * the same typed NOT_FOUND `retrievePaymentIntent` throws.
   *
   * Optional, like `getRefund`: the not-configured and e2e stand-in
   * processors do not implement it. A caller that needs it and finds it
   * missing must refuse, never fall back to an unchecked retrieve.
   */
  retrievePaymentIntentWithClientSecret?(input: {
    paymentIntentId: string;
  }): Promise<{
    id: string;
    status: string;
    amountReceived: number;
    currency: string;
    metadata: Record<string, string>;
    clientSecret: string | null;
  }>;

  /**
   * Retrieves the charge ID from a PaymentIntent.
   * Returns the latest_charge for the given PaymentIntent.
   */
  getChargeIdForPaymentIntent(input: {
    paymentIntentId: string;
  }): Promise<{ chargeId: string }>;

  /**
   * Determines the payment method type used on a PaymentIntent.
   *
   * Inspects the latest charge's `payment_method_details.type` to return
   * the canonical Stripe method type (e.g. "card", "us_bank_account",
   * "cashapp", "amazon_pay"). Returns null when no charge exists yet
   * (e.g. the PI is still processing without a charge).
   */
  getPaymentMethodType(input: {
    paymentIntentId: string;
  }): Promise<{
    methodType: string | null;
    /**
     * Card AVS/CVC check results from the same charge read, when the method
     * is a card and the processor reports them. Optional so stub/e2e
     * processors that only return `methodType` stay valid; consumers treat
     * absent as "not observed", never as "checks failed".
     */
    cardChecks?: PaymentCardChecks | null;
  }>;

  // ── Stripe Connect ──────────────────────────────────────────────────────

  /**
   * Creates a Stripe Connect Express account for an organizer/human.
   */
  createConnectAccount(
    input: CreateConnectAccountInput,
  ): Promise<{ accountId: string }>;

  /**
   * Generates a Stripe-hosted onboarding link for a Connect Express account.
   */
  createAccountOnboardingLink(input: {
    accountId: string;
    returnUrl: string;
    refreshUrl: string;
  }): Promise<{ url: string }>;

  /**
   * Generates a single-use link to a Connect Express account's Stripe-hosted
   * dashboard (balance, payouts, payments). Only valid for accounts that use
   * the Express Dashboard and have payouts enabled.
   */
  createConnectLoginLink(input: { accountId: string }): Promise<{ url: string }>;

  /**
   * Retrieves the current status of a Connect account (charges, payouts, requirements).
   */
  getConnectAccountStatus(input: { accountId: string }): Promise<{
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
    requirements: {
      currentlyDue: string[];
      eventuallyDue: string[];
      pastDue: string[];
    };
    /**
     * Raw capability statuses, when the processor exposes them.
     *
     * Needed because `payouts_enabled` alone is NOT sufficient to decide we can
     * pay a connected account: a destination transfer additionally requires the
     * `transfers` capability to be active, and that is the only local guard
     * before `createTransfer` (see settlements/run-batch.ts). Optional so
     * stub/e2e processors that omit it are treated as "no capability
     * information" rather than "capabilities inactive".
     *
     * Values are `string`, not an enum: Stripe ships `unrequested`,
     * `provisioning` and `disabled` alongside active/pending/inactive.
     */
    capabilities?: {
      transfers?: string | null;
      card_payments?: string | null;
    } | null;
    /**
     * The connected account's payout schedule, when the processor exposes
     * it. Read by the payout notification so it can tell the payee roughly
     * when the transfer reaches their bank (`delayDays` = Stripe's
     * `settings.payouts.schedule.delay_days`). Optional AND nullable: stubs
     * that omit it mean "unknown", and the notification then says nothing
     * about timing rather than guessing.
     */
    payoutSchedule?: { interval: string; delayDays: number } | null;
  }>;

  // ── Stripe Terminal / in-person POS ─────────────────────────────────────

  /**
   * Mints a short-lived connection token for the Stripe Terminal SDK
   * running on an operator's device (Tap to Pay on iPhone / Android NFC).
   *
   * The SDK calls a server endpoint which calls this method to fetch a
   * fresh token before connecting to a reader.
   *
   * The token is minted on the PLATFORM account, NOT the connected
   * account: under SCT the card-present PaymentIntent is created on the
   * platform, and a device authenticated against the connected account
   * would 404 when it tried to retrieve that PI by client secret. The
   * `stripeAccountId` input is retained for symmetry with a future
   * direct-charge flow and is ignored by the Stripe adapter.
   *
   * The returned `secret` MUST NOT be logged and MUST NOT be persisted.
   * Implementations should treat token-mint failures as transient and
   * surface them to the caller for a normal retry.
   */
  createTerminalConnectionToken(input: {
    /** Stripe Connect account ID (acct_xxx) of the org being sold for. */
    stripeAccountId: string;
  }): Promise<{ secret: string }>;

  /**
   * Creates a Stripe Terminal Location on the PLATFORM account.
   *
   * Under the SCT (separate-charge-and-transfer) charge model used for
   * POS Tap to Pay, every PaymentIntent is created on the platform
   * account, so the Reader/Location must also live on the platform
   * account — NOT per connected account. One Location is enough for
   * the entire platform; the address field is metadata only and does
   * not drive tax, interchange, or merchant-of-record routing (sales
   * tax is calculated separately via per-event venue address).
   */
  createTerminalLocation(input: {
    displayName: string;
    address: {
      line1: string;
      city: string;
      state: string;
      postalCode: string;
      /** Two-letter ISO country code, e.g. "US". */
      country: string;
    };
  }): Promise<{ locationId: string }>;

  /**
   * Creates a PaymentIntent configured for in-person card-present
   * collection via Stripe Terminal Tap to Pay.
   *
   * Differs from `createPaymentIntent` in three ways:
   *   1. `payment_method_types: ["card_present"]` is pinned.
   *   2. `capture_method: "automatic"` (no manual capture step at the till).
   *   3. The PI is created on the PLATFORM account with NO
   *      `application_fee_amount` and NO `on_behalf_of` — this is
   *      separate-charge-and-transfer (D-2026-04-26). Funds land on the
   *      platform balance and the payout batch moves them to
   *      the connected account on the event's payout schedule.
   *
   * The returned `clientSecret` is consumed by the Terminal SDK on the
   * operator's device (Tap to Pay). For a server-driven smart reader the
   * caller instead passes the PaymentIntent id to
   * `processPaymentIntentOnReader` and never touches the client secret.
   */
  createCardPresentPaymentIntent(input: {
    amountCents: number;
    currency: string;
    /**
     * Connected account ID the eventual transfer should land on. Stored in
     * PaymentIntent metadata for the payout batch (`settlements.run-batch`)
     * to read; NOT used as a `stripeAccount` request option (this is a
     * platform-account PI per decision D-2026-04-26 —
     * separate-charge-and-transfer).
     */
    destinationAccountId: string;
    /**
     * Metadata MUST include at minimum `orderId`, `eventId`, and
     * `paymentChannel: "POS"` so reconciliation tooling can attribute
     * the PI to its order. The adapter additionally stamps
     * `destinationAccountId` from the field above.
     */
    metadata: Record<string, string>;
    /**
     * Stable idempotency key for retry-safe creation. Use the same
     * `pos:{actorHumanId}:{clientKey}` pattern as web checkout.
     */
    idempotencyKey: string;
    /**
     * Optional org-name suffix for the cardholder statement descriptor.
     * Surfaces "Ithas Fire · {org}" on the buyer's bank statement.
     */
    statementDescriptorSuffix?: string;
    /**
     * Optional human-readable summary for the processor Dashboard / exports —
     * NOT the statement descriptor above and NOT shown to the buyer. Build it
     * with `buildPaymentDescription` (`@th/core` →
     * `lib/payments/payment-description`), passing `kind: "pos"` so the string
     * carries its POS segment.
     */
    description?: string;
  }): Promise<{ paymentIntentId: string; clientSecret: string }>;

  // ── Server-driven smart readers ─────────────────────────────────────────
  //
  // Internet-connected countertop readers (WisePOS E, Reader S700) are driven
  // entirely from the server: we POST to Stripe, Stripe relays the prompt to
  // the reader over the connection the reader already holds open. The browser
  // never talks to the reader and never holds a connection token — it polls
  // order state instead. Contrast with Tap to Pay, which is device-local and
  // therefore native-only.
  //
  // Every method here operates on the PLATFORM account, matching the Location
  // and card-present PIs above.

  /**
   * Claims a physical reader for the platform account using the short
   * registration code the device shows on screen, and binds it to
   * `locationId`.
   *
   * This is an ownership claim at Stripe, not a network connection — after it
   * succeeds the reader is addressable by the returned id. Which ORG owns the
   * reader is tracked only in our `pos_readers` table.
   *
   * Implementations should surface an invalid/expired code distinctly so the
   * caller can tell the operator to re-read the screen rather than retry.
   */
  registerTerminalReader(input: {
    /** Short code displayed by the reader, e.g. "puppies-plug-could". */
    registrationCode: string;
    label: string;
    locationId: string;
  }): Promise<{
    readerId: string;
    deviceType: string | null;
    /** Stripe's connectivity view at registration time. */
    status: "online" | "offline" | null;
  }>;

  /** Current reader state, used to pre-flight a sale and to poll an action. */
  getTerminalReader(input: { readerId: string }): Promise<{
    readerId: string;
    label: string | null;
    deviceType: string | null;
    status: "online" | "offline" | null;
    /** Present while the reader is mid-action (e.g. collecting a payment). */
    action: {
      type: string;
      status: "in_progress" | "succeeded" | "failed";
      failureCode: string | null;
      failureMessage: string | null;
    } | null;
  }>;

  /** Releases the reader from the platform account so it can be re-paired. */
  deleteTerminalReader(input: { readerId: string }): Promise<void>;

  /**
   * Pushes a PaymentIntent to the reader — the reader wakes, displays the
   * amount, and waits for a tap/dip/swipe.
   *
   * Returns as soon as Stripe accepts the request; the payment itself
   * completes asynchronously. Authoritative completion arrives via the
   * `payment_intent.succeeded` webhook (same path as web checkout); the UI
   * polls order state meanwhile.
   *
   * Implementations should distinguish "reader is offline" and "reader is
   * already running an action" from generic failures, since both are
   * recoverable by the operator without a new cart.
   */
  processPaymentIntentOnReader(input: {
    readerId: string;
    paymentIntentId: string;
  }): Promise<{ actionStatus: "in_progress" | "succeeded" | "failed" }>;

  /**
   * Aborts whatever the reader is currently prompting for. Safe to call when
   * no action is in flight — implementations swallow that case so an operator
   * mashing "cancel" never sees an error.
   */
  cancelReaderAction(input: { readerId: string }): Promise<void>;

  // ── Disputes (chargebacks) ──────────────────────────────────────────────

  /**
   * Reads a dispute's current state, evidence deadline, and the evidence the
   * processor already holds. Read-only; safe to call at any time.
   *
   * Implementations should surface "no such dispute" as a typed
   * `NOT_FOUND` rather than a raw provider error.
   */
  retrieveDispute(input: {
    processorDisputeId: string;
  }): Promise<ProcessorDisputeSnapshot>;

  /**
   * Stages or submits evidence on a dispute.
   *
   * Semantics mirror Stripe's: the evidence hash is REPLACED field-by-field
   * by what is sent — absent keys are left as-is, so callers can send only
   * the fields they changed. `submit: false` stages the evidence for later;
   * `submit: true` sends the whole hash to the card network, which is
   * irreversible and counts against `evidenceDetails.submissionCount`.
   *
   * Implementations MUST run `checkDisputeEvidenceLimits` (ports/
   * dispute-evidence) over the fields in THIS call and throw
   * `DISPUTE_EVIDENCE_LIMIT_EXCEEDED` BEFORE contacting the processor — a
   * limit rejection after "submit" is a confusing failure for the operator,
   * and the pure check is cheap. That adapter pre-flight is necessarily
   * partial: the processor's combined cap applies to the MERGED hash
   * (already-staged evidence plus this update), and the adapter does not read
   * before every write. A submitting use case must `retrieveDispute`, pass
   * `snapshot.evidence` as the helper's `existing` argument, and check the
   * merge itself.
   *
   * File-reference fields must carry ids minted by
   * `uploadDisputeEvidenceFile`; a file id may be used in exactly one
   * request, so a retry after a successful update must not re-send it.
   *
   * Idempotency: derive this key and every `uploadDisputeEvidenceFile` key
   * for the same attempt from ONE immutable attempt id —
   * `dispute-evidence:<disputeId>:<attemptId>:update` here and
   * `dispute-evidence:<disputeId>:<attemptId>:file:<slot>` for uploads — so
   * a crash-and-retry replays the whole pair as a unit, and a genuine
   * re-upload (new bytes, edited text) gets a NEW attempt id. Reusing a key
   * with different params is a processor-side `idempotency_error` (Stripe:
   * 400), which this port does not translate.
   */
  updateDisputeEvidence(input: {
    processorDisputeId: string;
    evidence: DisputeEvidenceFields;
    submit: boolean;
    /**
     * Stable provider-scoped idempotency key. Recommended for `submit: true`
     * so a crash-and-retry cannot double-submit. Format and pairing rule are
     * in the method doc above.
     */
    idempotencyKey?: string;
  }): Promise<ProcessorDisputeSnapshot>;

  /**
   * Uploads a document for use as dispute evidence and returns the
   * processor's file id, which the caller then places into a file-reference
   * field of `DisputeEvidenceFields`. Each id is single-use at the
   * processor: upload once per evidence update, never cache across updates.
   *
   * `data` is the raw bytes; the adapter must not log or persist them.
   *
   * Idempotency: same rule as `updateDisputeEvidence` — key this upload as
   * `dispute-evidence:<disputeId>:<attemptId>:file:<slot>` using the SAME
   * attempt id as the update it feeds, so the pair replays together on a
   * retry. A same-key replay returns the original file id (which the paired
   * update, also replayed, may still consume); a changed file needs a new
   * attempt id, never the old key with new bytes.
   */
  uploadDisputeEvidenceFile(input: {
    data: Uint8Array;
    /** Filename shown in the processor dashboard, e.g. "receipt.pdf". */
    filename: string;
    /** MIME type, e.g. "application/pdf" or "image/png". */
    contentType: string;
    /**
     * Stable provider-scoped idempotency key for retry-safe upload. Format
     * and pairing rule are in the method doc above.
     */
    idempotencyKey?: string;
  }): Promise<{ processorFileId: string }>;

  // ── Tax ─────────────────────────────────────────────────────────────────

  /**
   * Calculates tax for a set of line items using the provider's Tax API.
   *
   * Returns the total exclusive tax amount and a reference ID for the calculation.
   * If the provider doesn't support tax or the address is insufficient, returns
   * `{ taxAmountCents: 0, calculationId: null }`.
   */
  calculateTax(input: {
    currency: string;
    /** Line items in smallest currency unit (cents). */
    lineItems: Array<{
      amountCents: number;
      /** Arbitrary reference string (e.g. "ticket:<ticketTypeId>"). */
      reference: string;
    }>;
    /** Customer billing address for tax jurisdiction resolution. */
    customerAddress: {
      line1: string;
      city: string;
      state: string;
      postalCode: string;
      /** Two-letter ISO country code (e.g. "US"). */
      country: string;
    };
  }): Promise<{
    taxAmountCents: number;
    calculationId: string | null;
  }>;
}
