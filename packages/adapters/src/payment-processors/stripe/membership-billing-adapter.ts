import Stripe from "stripe";
import type {
  MembershipBillingPort,
  MembershipSubscriptionSnapshot,
} from "@th/ports/membership-billing-port";

type Ctx = {
  apiKey: string;
  apiVersion?: Stripe.LatestApiVersion;
  /** API base URL override (e.g. http://127.0.0.1:12111) for stripe-mock. */
  baseUrl?: string;
};

/**
 * Stripe Billing implementation of {@link MembershipBillingPort}.
 *
 * Every write takes an idempotency key, because these run from webhook and
 * retry paths where a duplicate Product, Price or Subscription is not a
 * cosmetic problem — a duplicate subscription bills a member twice.
 */
export class StripeMembershipBilling implements MembershipBillingPort {
  private s: Stripe;

  constructor({
    apiKey,
    apiVersion = "2025-08-27.basil" as const,
    baseUrl,
  }: Ctx) {
    // Mirrors StripePaymentProcessor: the SDK takes host/protocol overrides so
    // stripe-mock (HTTP, usually :12111) can stand in.
    const host = baseUrl ? new URL(baseUrl).host : undefined;
    const protocol = baseUrl
      ? new URL(baseUrl).protocol.replace(":", "")
      : undefined;
    this.s = new Stripe(apiKey, {
      apiVersion,
      ...(host ? { host } : null),
      ...(protocol ? { protocol: protocol as "http" | "https" } : null),
    });
  }

  async ensureCustomer(input: {
    humanId: string;
    email?: string | null;
    name?: string | null;
    idempotencyKey?: string;
  }): Promise<{ customerId: string }> {
    // Search before create so a retry, or a member returning months later,
    // reuses the same Customer — the saved card lives on it, and that single
    // card across every owner is the whole point of platform-owned customers.
    const existing = await this.s.customers.search({
      query: `metadata['humanId']:'${input.humanId}'`,
      limit: 1,
    });
    const found = existing.data[0];
    if (found) return { customerId: found.id };

    const created = await this.s.customers.create(
      {
        ...(input.email ? { email: input.email } : {}),
        ...(input.name ? { name: input.name } : {}),
        metadata: { humanId: input.humanId },
      },
      input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : undefined,
    );
    return { customerId: created.id };
  }

  async ensureProduct(input: {
    tierId: string;
    name: string;
    description?: string | null;
    statementDescriptor?: string;
    idempotencyKey?: string;
  }): Promise<{ productId: string }> {
    const existing = await this.s.products.search({
      query: `metadata['tierId']:'${input.tierId}'`,
      limit: 1,
    });
    const found = existing.data[0];
    if (found) {
      // HEAL, not just find: Products (unlike Prices) are mutable, and the
      // descriptor is what the member's card statement renders. Products
      // minted before descriptors existed — and products whose owner renamed
      // — get repaired here on the next publish, without touching the Price.
      if (
        input.statementDescriptor !== undefined &&
        (found.statement_descriptor ?? null) !== input.statementDescriptor
      ) {
        await this.s.products.update(found.id, {
          statement_descriptor: input.statementDescriptor,
        });
      }
      return { productId: found.id };
    }

    const created = await this.s.products.create(
      {
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        ...(input.statementDescriptor
          ? { statement_descriptor: input.statementDescriptor }
          : {}),
        metadata: { tierId: input.tierId },
      },
      input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : undefined,
    );
    return { productId: created.id };
  }

  async createPrice(input: {
    productId: string;
    unitAmountCents: number;
    currency: string;
    interval: "month" | "year";
    idempotencyKey?: string;
  }): Promise<{ priceId: string }> {
    const price = await this.s.prices.create(
      {
        product: input.productId,
        unit_amount: input.unitAmountCents,
        currency: input.currency.toLowerCase(),
        recurring: { interval: input.interval },
      },
      input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : undefined,
    );
    return { priceId: price.id };
  }

  async ensureTaxRate(input: {
    jurisdictionId: string;
    displayName: string;
    percentage: number;
    inclusive: boolean;
    country?: string | null;
    idempotencyKey?: string;
  }): Promise<{ taxRateId: string }> {
    // THIS IS NOT STRIPE TAX. Stripe Tax is `automatic_tax: { enabled: true }`
    // — a calculation engine that decides rates and tracks nexus, billed at
    // 0.5% per transaction where you are registered. It is deliberately not
    // used anywhere in this codebase, and `automatic_tax` should never appear.
    //
    // A TaxRate object is just a stored percentage that WE supply. ZipTax makes
    // every rate decision; Stripe only multiplies and renders it on the
    // invoice. There is no per-transaction charge for this.
    //
    // The alternative — injecting a tax line item ourselves — works for
    // ticketing because we create that PaymentIntent, but subscriptions are
    // invoiced by Stripe unattended on every renewal, so it would mean
    // intercepting `invoice.created` before finalization forever, and a single
    // missed interception silently under-collects.
    //
    // TaxRates cannot be searched by metadata, so the caller is responsible for
    // remembering the id on the jurisdiction row. The idempotency key is what
    // stops a retry from minting a duplicate rate.
    const created = await this.s.taxRates.create(
      {
        display_name: input.displayName,
        percentage: input.percentage,
        inclusive: input.inclusive,
        ...(input.country ? { country: input.country } : {}),
        metadata: { jurisdictionId: input.jurisdictionId },
      },
      input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : undefined,
    );
    return { taxRateId: created.id };
  }

  async createSubscription(input: {
    customerId: string;
    priceId: string;
    defaultTaxRateIds?: string[];
    metadata?: Record<string, string>;
    idempotencyKey?: string;
  }): Promise<MembershipSubscriptionSnapshot> {
    const subscription = await this.s.subscriptions.create(
      {
        customer: input.customerId,
        items: [{ price: input.priceId }],
        // NO `transfer_data` and NO `application_fee_percent` — deliberately.
        // The charge settles on the platform account and the owner is paid by
        // the Orders/Settlement pipeline (`recordMembershipInvoicePaid` mints a
        // 100% OrderSplit; `runPayoutBatch` transfers it). A destination charge
        // here would move the money a SECOND time and forfeit payout timing
        // control and the dispute-hold machinery. See the port's invariant 2
        // and the recurring-memberships spec (2026-08-08 revision).
        //
        // `default_incomplete`: the platform-owned Customer has NO payment
        // method at signup (nothing has ever collected one), so a default
        // `payment_behavior` would reject with "customer has no attached
        // payment source". Instead the subscription starts `incomplete`, the
        // first invoice's PaymentIntent client secret goes back to the
        // browser, and Stripe Elements confirms it there.
        payment_behavior: "default_incomplete",
        payment_settings: {
          // The confirmed card becomes the subscription's default payment
          // method, so every renewal bills it unattended.
          save_default_payment_method: "on_subscription",
        },
        // Basil API: `Invoice.payment_intent` no longer exists — the
        // first-invoice client secret lives at
        // `latest_invoice.confirmation_secret.client_secret`, and is only
        // present when explicitly expanded.
        expand: ["latest_invoice.confirmation_secret"],
        ...(input.defaultTaxRateIds?.length
          ? { default_tax_rates: input.defaultTaxRateIds }
          : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
      input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : undefined,
    );
    return snapshot(subscription);
  }

  async updateSubscriptionTaxRates(input: {
    subscriptionId: string;
    defaultTaxRateIds: string[];
    idempotencyKey?: string;
  }): Promise<MembershipSubscriptionSnapshot> {
    const updated = await this.s.subscriptions.update(
      input.subscriptionId,
      {
        // An empty ARRAY is silently dropped by Stripe's form encoding — the
        // request would arrive with the field omitted and the old rates would
        // keep billing. The documented "unset" sentinel is the empty string
        // (SubscriptionUpdateParams.default_tax_rates: Emptyable<string[]>),
        // which is what a genuine 0% jurisdiction needs: clear, not no-op.
        default_tax_rates: input.defaultTaxRateIds.length
          ? input.defaultTaxRateIds
          : "",
      },
      input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : undefined,
    );
    return snapshot(updated);
  }

  async cancelSubscription(input: {
    subscriptionId: string;
    atPeriodEnd?: boolean;
    idempotencyKey?: string;
  }): Promise<MembershipSubscriptionSnapshot> {
    const atPeriodEnd = input.atPeriodEnd ?? true;

    if (atPeriodEnd) {
      const updated = await this.s.subscriptions.update(
        input.subscriptionId,
        { cancel_at_period_end: true },
        input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : undefined,
      );
      return snapshot(updated);
    }

    const canceled = await this.s.subscriptions.cancel(input.subscriptionId);
    return snapshot(canceled);
  }

  async getSubscription(input: {
    subscriptionId: string;
  }): Promise<MembershipSubscriptionSnapshot | null> {
    try {
      const subscription = await this.s.subscriptions.retrieve(
        input.subscriptionId,
      );
      return snapshot(subscription);
    } catch (err) {
      // A subscription that no longer exists is a normal answer to "what is
      // its state", not an exceptional one.
      if (
        err instanceof Stripe.errors.StripeInvalidRequestError &&
        err.statusCode === 404
      ) {
        return null;
      }
      throw err;
    }
  }

  async createPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const session = await this.s.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    return { url: session.url };
  }
}

/**
 * Read the billing period off the subscription's first item.
 *
 * As of the Basil API version (2025-03-31) Stripe MOVED `current_period_start`
 * and `current_period_end` off Subscription and onto SubscriptionItem — they no
 * longer exist at the top level at all. Taking item[0] is well-defined here
 * because a membership subscription is created with exactly one price; if that
 * ever changes, per-item periods become a real modelling question rather than
 * something to paper over, so this throws instead of guessing.
 */
function snapshot(
  subscription: Stripe.Subscription,
): MembershipSubscriptionSnapshot {
  const item = subscription.items?.data?.[0];
  if (!item) {
    throw new Error(
      `stripe membership billing: subscription ${subscription.id} has no items, so it has no billing period`,
    );
  }

  return {
    subscriptionId: subscription.id,
    status: subscription.status,
    currentPeriodStart: new Date(item.current_period_start * 1000),
    currentPeriodEnd: new Date(item.current_period_end * 1000),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    canceledAt: subscription.canceled_at
      ? new Date(subscription.canceled_at * 1000)
      : null,
    paymentIntentClientSecret: firstInvoiceClientSecret(subscription),
  };
}

/**
 * The first invoice's PaymentIntent client secret, when present.
 *
 * Only `createSubscription` expands `latest_invoice.confirmation_secret`, so
 * on every other call `latest_invoice` is an id string (or absent) and this is
 * null — which matches the port contract: the secret is a create-time-only
 * hand-off to the browser. Also legitimately null on create when the first
 * invoice needs no payment (100% discount / trial): Stripe mints no
 * PaymentIntent, so there is no confirmation secret.
 */
function firstInvoiceClientSecret(
  subscription: Stripe.Subscription,
): string | null {
  const invoice = subscription.latest_invoice;
  if (!invoice || typeof invoice === "string") return null;
  return invoice.confirmation_secret?.client_secret ?? null;
}

export function createStripeMembershipBilling(ctx: Ctx): MembershipBillingPort {
  return new StripeMembershipBilling(ctx);
}
