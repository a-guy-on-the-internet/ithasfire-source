/**
 * Recurring billing for memberships.
 *
 * Deliberately a sibling of `PaymentProcessorPort` rather than an extension of
 * it: that port is shaped around one-off PaymentIntents, and subscriptions
 * bring an entirely different vocabulary (products, immutable prices,
 * customers, tax rates, a hosted portal). Bolting them together would make one
 * fat interface that every non-membership implementation has to stub.
 *
 * Two invariants the implementation MUST hold, because the money model depends
 * on them:
 *
 *  1. The Customer is PLATFORM-owned, never created on the connected account.
 *     That is what lets a member supporting three venues enter their card once.
 *     A Customer created on a connected account is siloed to that account.
 *
 *  2. Subscription charges settle on the PLATFORM account with NO
 *     `transfer_data.destination` and NO `application_fee_percent`. The owner
 *     is paid through the Orders/Settlement pipeline instead:
 *     `recordMembershipInvoicePaid` materialises each paid invoice as an Order
 *     with a 100% OrderSplit, and `runPayoutBatch` moves the money. Destination
 *     charges would move funds at charge time — forfeiting payout timing
 *     control AND the dispute-hold machinery — and, combined with the
 *     settlement pipeline, would pay the owner TWICE (recurring-memberships
 *     spec, 2026-08-08 revision: "No `transfer_data.destination`.").
 */

export type MembershipBillingInterval = "month" | "year";

/**
 * Mirrors Stripe's subscription status vocabulary rather than narrowing it.
 * Stripe has introduced values before; surfacing an unrecognised one is better
 * than failing to represent a real subscription state.
 */
export type MembershipSubscriptionStatus = string;

export interface MembershipSubscriptionSnapshot {
  subscriptionId: string;
  status: MembershipSubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  /**
   * Client secret of the PaymentIntent on the subscription's FIRST invoice.
   * Only `createSubscription` populates it (that call expands the latest
   * invoice); reads and cancels return null. Also null when the first invoice
   * needs no payment at all (a 100%-discounted or trialing first period).
   *
   * Lifecycle: subscriptions are created `payment_behavior:
   * "default_incomplete"`, so they start in status `incomplete` with no
   * payment method attached. The browser confirms this secret with Stripe
   * Elements, which attaches the card (saved for renewals via
   * `payment_settings.save_default_payment_method: "on_subscription"`) and
   * Stripe's webhooks (`customer.subscription.updated` +
   * `invoice.payment_succeeded`) flip the subscription active and mint the
   * Order. A subscription whose first invoice is never confirmed auto-expires
   * to `incomplete_expired` after ~23h; neither `incomplete` state grants
   * benefits (`MEMBERSHIP_BENEFIT_GRANTING_STATUSES`) or counts as live
   * (`MEMBERSHIP_LIVE_STATUSES`), so an abandoned signup grants nothing and
   * a re-join is not blocked.
   */
  paymentIntentClientSecret: string | null;
}

export interface MembershipBillingPort {
  /**
   * Platform-owned Customer for a member, created once and reused across every
   * owner they support. Implementations must be idempotent on `humanId`.
   */
  ensureCustomer(input: {
    humanId: string;
    email?: string | null;
    name?: string | null;
    idempotencyKey?: string;
  }): Promise<{ customerId: string }>;

  /**
   * Product for a tier. Idempotent on `tierId`.
   *
   * `statementDescriptor` is what the member's CARD STATEMENT shows for every
   * charge on this tier's subscriptions — subscriptions take their descriptor
   * from the Product, having no descriptor field of their own. It must be the
   * OWNER's name (venue/artist), pre-sanitised to Stripe's 22-char rules via
   * `buildStatementDescriptor` in core; an unrecognised descriptor is the
   * leading cause of "is this fraud?" chargebacks on recurring billing.
   *
   * Unlike Prices, Products are MUTABLE: when the product already exists and
   * carries a different descriptor, implementations must UPDATE it rather than
   * return as-is — that heal is what repairs products minted before
   * descriptors existed (and follows an owner rename) on the next publish.
   */
  ensureProduct(input: {
    tierId: string;
    name: string;
    description?: string | null;
    statementDescriptor?: string;
    idempotencyKey?: string;
  }): Promise<{ productId: string }>;

  /**
   * A Price for a tier's amount and cadence.
   *
   * Stripe Prices are IMMUTABLE, which is why there is no `updatePrice`: a
   * price change is always archive-and-replace, and the tier's `priceCents` is
   * correspondingly frozen once it has a subscriber.
   */
  createPrice(input: {
    productId: string;
    unitAmountCents: number;
    currency: string;
    interval: MembershipBillingInterval;
    idempotencyKey?: string;
  }): Promise<{ priceId: string }>;

  /**
   * A TaxRate for one jurisdiction, referenced by many subscriptions via
   * `default_tax_rates`.
   *
   * `percentage` is immutable on Stripe's side too, so a rate change means
   * archiving this one and creating a replacement — which is exactly why our
   * jurisdiction cache archives rather than mutates.
   */
  ensureTaxRate(input: {
    jurisdictionId: string;
    displayName: string;
    percentage: number;
    inclusive: boolean;
    country?: string | null;
    idempotencyKey?: string;
  }): Promise<{ taxRateId: string }>;

  /**
   * A platform-account subscription. Deliberately NO destination account and
   * NO application fee on this call — the owner is paid via the
   * Orders/Settlement pipeline, not by Stripe at charge time (invariant 2
   * above). A platform fee, if one ever exists, is charged on the Order.
   *
   * Created `default_incomplete`: the member has no payment method on file
   * yet, so the first invoice's PaymentIntent client secret comes back on the
   * snapshot and the browser confirms it with Stripe Elements (see
   * {@link MembershipSubscriptionSnapshot.paymentIntentClientSecret}).
   */
  createSubscription(input: {
    customerId: string;
    priceId: string;
    /** Jurisdiction tax rates to apply. Empty when the rate is a genuine 0%. */
    defaultTaxRateIds?: string[];
    metadata?: Record<string, string>;
    idempotencyKey?: string;
  }): Promise<MembershipSubscriptionSnapshot>;

  /**
   * Re-point a LIVE subscription's `default_tax_rates` — the
   * billing-address-change path. A member who moves keeps billing at the old
   * jurisdiction's rate forever unless the live subscription is migrated; as
   * merchant of record that shortfall is ours, not theirs.
   *
   * An EMPTY `defaultTaxRateIds` means a genuine 0% jurisdiction and must
   * CLEAR any previously-set rates, not no-op. (Stripe's form encoding drops
   * an empty array entirely, so implementations must send the documented
   * empty-string "unset" sentinel instead — an omitted field leaves the old
   * rates billing.)
   *
   * Applies to invoices from the NEXT billing period; the current period was
   * already invoiced at the old rate, which is correct — that charge happened
   * at the old address.
   */
  updateSubscriptionTaxRates(input: {
    subscriptionId: string;
    defaultTaxRateIds: string[];
    idempotencyKey?: string;
  }): Promise<MembershipSubscriptionSnapshot>;

  cancelSubscription(input: {
    subscriptionId: string;
    /**
     * Default true. Immediate cancellation is a separate, explicit decision —
     * a member who paid for the period keeps it.
     */
    atPeriodEnd?: boolean;
    idempotencyKey?: string;
  }): Promise<MembershipSubscriptionSnapshot>;

  getSubscription(input: {
    subscriptionId: string;
  }): Promise<MembershipSubscriptionSnapshot | null>;

  /**
   * Hosted portal session for self-serve card update and cancellation.
   *
   * This is load-bearing for dispute prevention, not a convenience: the single
   * commonest chargeback reason on recurring billing is a member who could not
   * find how to cancel.
   */
  createPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }>;
}
