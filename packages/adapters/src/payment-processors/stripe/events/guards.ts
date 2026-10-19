// adapters/stripe/events/guards.ts
import { z } from "zod";

export const PaymentIntentSucceededZ = z.object({
  id: z.string().startsWith("pi_"),
  object: z.literal("payment_intent"),
  status: z.literal("succeeded"),
  amount: z.number().int(),
  currency: z.string(),
  metadata: z.record(z.string(), z.string()).optional(),
});

export const PaymentIntentFailedZ = z.object({
  id: z.string().startsWith("pi_"),
  object: z.literal("payment_intent"),
  status: z
    .literal("requires_payment_method")
    .or(z.literal("canceled"))
    .or(z.literal("processing")),
});

/**
 * Guard for `account.updated`.
 *
 * Two deliberate looseness choices, both of which were previously silent
 * data-loss bugs — a parse failure here `break`s out of the webhook with a
 * (Sentry-invisible) warn and a 200, so Stripe never retries and the capability
 * state is lost forever:
 *
 * 1. Capability statuses are `z.string()`, not an enum. Stripe ships values
 *    beyond active/pending/inactive — `unrequested`, `provisioning`,
 *    `disabled` — and any of them made the whole event unparseable.
 * 2. `charges_enabled` / `payouts_enabled` are carried. They are the
 *    account-level roll-up the Payments settings page renders, and the `Payee`
 *    row must be derived from the same fields or the two surfaces diverge (the
 *    publish-gate outage). See `deriveConnectCapabilities`.
 */
export const AccountUpdatedZ = z.object({
  id: z.string().startsWith("acct_"),
  object: z.literal("account"),
  charges_enabled: z.boolean().optional(),
  payouts_enabled: z.boolean().optional(),
  capabilities: z
    .object({
      // `.nullish()`, not `.optional()`: an explicit `null` must not fail the
      // guard and DLQ the whole event — that is the exact failure mode the
      // looseness above exists to prevent.
      transfers: z.string().nullish(),
      card_payments: z.string().nullish(),
    })
    .loose()
    .optional(),
  default_currency: z.string().optional(),
  requirements: z.any().optional(),
});

export const ChargeRefundedZ = z.object({
  id: z.string().startsWith("ch_"),
  object: z.literal("charge"),
  refunded: z.boolean(),
  payment_intent: z.string().startsWith("pi_").nullable(),
  amount_refunded: z.number().int(),
  /**
   * The charge's embedded refund list — present on API versions before
   * 2023-08-16, ABSENT after (Stripe stopped including `charge.refunds` by
   * default). Optional so both shapes parse; when present, `data[0]` is the
   * most-recent refund (Stripe sorts reverse-chronological) — i.e. the
   * refund that fired this event — which partial-refund reconciliation
   * needs as its idempotency key.
   */
  refunds: z
    .object({
      data: z.array(z.object({ id: z.string().startsWith("re_") })),
    })
    .nullish(),
});

/**
 * Zod guard for the `charge.refund.updated` webhook event.
 *
 * Stripe fires this when an *asynchronous* refund (ACH, bank transfer, etc.)
 * transitions from `pending` to `succeeded` or `failed`. The `status` field
 * is the critical discriminator.
 */
export const RefundUpdatedZ = z.object({
  id: z.string().startsWith("re_"),
  object: z.literal("refund"),
  status: z.enum([
    "pending",
    "succeeded",
    "failed",
    "requires_action",
    "canceled",
  ]),
  amount: z.number().int(),
  currency: z.string(),
  charge: z.string().startsWith("ch_").nullable(),
  payment_intent: z.string().startsWith("pi_").nullable(),
  failure_reason: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
});

/**
 * Zod guard for `account.application.deauthorized`.
 *
 * Stripe fires this when a connected account revokes your platform's
 * authorization. The payload is the account object at time of revocation.
 */
export const AccountDeauthorizedZ = z.object({
  id: z.string().startsWith("acct_"),
  object: z.literal("account"),
});

/**
 * A Stripe id that may arrive bare or expanded. Normalises to the id string.
 *
 * Webhook payloads are unexpanded by default, so these are almost always
 * strings — but a replayed event captured with `expand` set, or a future
 * Dashboard-side change, would otherwise fail the guard and DLQ a real invoice.
 */
const expandableId = z
  .union([z.string(), z.object({ id: z.string() }).loose()])
  .transform((value) => (typeof value === "string" ? value : value.id));

/**
 * Guard for the Stripe Billing invoice events (`invoice.payment_succeeded`,
 * `invoice.payment_failed`).
 *
 * Deliberately `.loose()` and generous, for the same reason `AccountUpdatedZ`
 * is: a parse failure here DLQs a **paid membership invoice**, which is money
 * that arrived and was never recorded. Only fields we actually read are named.
 *
 * Two API-version notes that are easy to get wrong:
 *
 *  - **The subscription moved.** Up to 2025-03-31 it was `invoice.subscription`;
 *    from Basil (the version this codebase pins) it is
 *    `invoice.parent.subscription_details.subscription`. BOTH are accepted so a
 *    replay of an older stored event still resolves.
 *  - **Tax moved too.** `invoice.tax` became `invoice.total_taxes[]`, an array
 *    carrying `tax_behavior`. Callers must sum only the EXCLUSIVE entries —
 *    inclusive tax is already inside `subtotal`, so adding it would double-count.
 */
export const MembershipInvoiceZ = z
  .object({
    id: z.string().startsWith("in_"),
    object: z.literal("invoice"),
    currency: z.string(),
    /** Pre-tax, post-item-discount. The membership split basis. */
    subtotal: z.number().int(),
    amount_paid: z.number().int(),
    amount_due: z.number().int(),
    created: z.number().int(),
    period_start: z.number().int(),
    period_end: z.number().int(),
    attempt_count: z.number().int().nullish(),
    next_payment_attempt: z.number().int().nullish(),
    customer: expandableId.nullish(),
    total_taxes: z
      .array(
        z
          .object({
            amount: z.number().int(),
            /** "inclusive" | "exclusive". String, not an enum — see above. */
            tax_behavior: z.string().nullish(),
          })
          .loose(),
      )
      .nullish(),
    /**
     * Legacy (pre-Basil) tax total, an integer. Replaced by `total_taxes[]`.
     * Kept so a stored older event still replays with its tax intact — see
     * `membershipInvoiceExclusiveTaxCents`.
     */
    tax: z.number().int().nullish(),
    /**
     * Basil+ location of the originating subscription. `metadata` is the
     * SUBSCRIPTION's metadata snapshot — `startMembership` stamps
     * `tierId`/`memberHumanId` there, which is how the webhook can tell "ours,
     * row not committed yet" from "genuinely foreign" on the first-invoice
     * race (see `membershipInvoiceSubscriptionMetadata`).
     */
    parent: z
      .object({
        subscription_details: z
          .object({
            subscription: expandableId.nullish(),
            metadata: z.record(z.string(), z.string()).nullish(),
          })
          .loose()
          .nullish(),
      })
      .loose()
      .nullish(),
    /** Pre-Basil location. Kept so stored older events still replay. */
    subscription: expandableId.nullish(),
    /** Pre-Basil sibling of `parent.subscription_details`. Same fallback role. */
    subscription_details: z
      .object({ metadata: z.record(z.string(), z.string()).nullish() })
      .loose()
      .nullish(),
    /**
     * Basil replacement for the removed top-level `payment_intent`. Often absent
     * from an unexpanded webhook payload, which is why the PaymentIntent link is
     * optional on a membership order rather than required.
     */
    payments: z
      .object({
        data: z.array(
          z
            .object({
              payment: z
                .object({ payment_intent: expandableId.nullish() })
                .loose()
                .nullish(),
            })
            .loose(),
        ),
      })
      .loose()
      .nullish(),
  })
  .loose();

/**
 * Guard for `invoice.upcoming` — the pre-renewal preview Stripe emits ahead of
 * each subscription charge.
 *
 * IDENTICAL to `MembershipInvoiceZ` except the id: an upcoming invoice does
 * not exist yet, so the payload carries NO invoice id (Stripe documents the
 * field as absent for this event). Requiring `in_…` here would DLQ every
 * renewal notice by construction.
 */
export const MembershipUpcomingInvoiceZ = MembershipInvoiceZ.extend({
  id: z.string().nullish(),
});

/**
 * Guard for `customer.subscription.updated` / `customer.subscription.deleted`.
 *
 * `status` is `z.string()`, not an enum, for the reason spelled out on
 * `AccountUpdatedZ`: Stripe has added subscription statuses before (`paused`
 * arrived in 2022), and refusing to parse an unknown one would drop the very
 * lifecycle transition we exist to mirror.
 *
 * The billing period lives on `items.data[0]`, NOT on the subscription: Basil
 * (2025-03-31) moved `current_period_start` / `current_period_end` onto
 * SubscriptionItem and removed them from the top level. See `snapshot()` in
 * `membership-billing-adapter.ts`, which reads the same place.
 */
export const MembershipSubscriptionZ = z
  .object({
    id: z.string().startsWith("sub_"),
    object: z.literal("subscription"),
    status: z.string().min(1),
    cancel_at_period_end: z.boolean().nullish(),
    canceled_at: z.number().int().nullish(),
    /**
     * Legacy (pre-Basil) top-level billing period. A replayed older event
     * carries the period HERE and has no per-item periods; without the
     * fallback in `membershipSubscriptionPeriod` those parse to null and a
     * stale `active` can overwrite a newer state in
     * `syncMembershipFromStripe` (its ordering guard needs the period).
     */
    current_period_start: z.number().int().nullish(),
    current_period_end: z.number().int().nullish(),
    items: z
      .object({
        data: z.array(
          z
            .object({
              current_period_start: z.number().int().nullish(),
              current_period_end: z.number().int().nullish(),
            })
            .loose(),
        ),
      })
      .loose()
      .nullish(),
  })
  .loose();

/**
 * Guard for `customer.updated` — the billing-address-change signal.
 *
 * This event fires for MANY reasons (payment-method attach, email edit,
 * portal visits...), for EVERY customer on the platform account. The webhook
 * therefore treats it as cheap-by-default: only `id` and the billing
 * `address` are read, everything else rides `.loose()`, and the handler
 * short-circuits before any provider call when the postal code is unchanged.
 *
 * `address` is the Customer's BILLING address (what the hosted portal edits
 * and what card statements verify against) — deliberately not
 * `shipping.address`. Both sub-fields are `.nullish()`: Stripe sends explicit
 * nulls for cleared fields, and a parse failure here would DLQ every
 * payment-method update on the platform.
 */
export const CustomerUpdatedZ = z
  .object({
    id: z.string().startsWith("cus_"),
    object: z.literal("customer"),
    address: z
      .object({
        postal_code: z.string().nullish(),
        country: z.string().nullish(),
      })
      .loose()
      .nullish(),
  })
  .loose();

export type PaymentIntentSucceeded = z.infer<typeof PaymentIntentSucceededZ>;
export type PaymentIntentFailed = z.infer<typeof PaymentIntentFailedZ>;
export type AccountUpdated = z.infer<typeof AccountUpdatedZ>;
export type AccountDeauthorized = z.infer<typeof AccountDeauthorizedZ>;
/**
 * Zod guard for `radar.early_fraud_warning.created` / `.updated`.
 *
 * `charge` and `payment_intent` are expandable — a string id on the webhook
 * payload, an object only when a client asked for expansion — so both shapes
 * are accepted and collapsed to the id. `fraud_type` is a free string on
 * purpose: Stripe adds values without notice and a rejected enum would drop
 * the one event that gives ops a head start on a chargeback.
 */
const expandableIdZ = <P extends string>(prefix: P) =>
  z.union([
    z.string().startsWith(prefix),
    z.object({ id: z.string().startsWith(prefix) }).transform((o) => o.id),
  ]);

export const EarlyFraudWarningZ = z.object({
  id: z.string().startsWith("issfr_"),
  object: z.literal("radar.early_fraud_warning"),
  actionable: z.boolean(),
  charge: expandableIdZ("ch_"),
  payment_intent: expandableIdZ("pi_").nullish(),
  // Bounds match `recordEarlyFraudWarningInputSchema` so a guard-accepted
  // value can never fail the use case's boundary.
  fraud_type: z.string().min(1).max(64),
  created: z.number().int(),
});

export type ChargeRefunded = z.infer<typeof ChargeRefundedZ>;
export type EarlyFraudWarningEvent = z.infer<typeof EarlyFraudWarningZ>;
export type RefundUpdated = z.infer<typeof RefundUpdatedZ>;
export type MembershipInvoice = z.infer<typeof MembershipInvoiceZ>;
export type MembershipUpcomingInvoice = z.infer<
  typeof MembershipUpcomingInvoiceZ
>;
export type CustomerUpdated = z.infer<typeof CustomerUpdatedZ>;
export type MembershipSubscription = z.infer<typeof MembershipSubscriptionZ>;

/**
 * The customer's usable billing address, normalised to uppercase, or `null`
 * when there is nothing tax-resolution can act on.
 *
 * `null` is deliberately generous — missing address, missing postal code,
 * missing/malformed country (must be ISO-3166-1 alpha-2), or a postal code
 * beyond the 16 chars our resolver accepts. All of these are portal-typed
 * data, not retryable failures: the handler info-logs and no-ops rather than
 * DLQ-ing something a replay could never fix. The membership row keeps its
 * last known-good jurisdiction, which is the same fail-open stance
 * `updateMemberBillingAddress` takes for unpriceable moves.
 */
export function customerBillingAddress(
  customer: CustomerUpdated,
): { postalCode: string; countryCode: string } | null {
  const postalCode = customer.address?.postal_code?.trim().toUpperCase();
  const countryCode = customer.address?.country?.trim().toUpperCase();
  if (!postalCode || postalCode.length > 16) return null;
  if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) return null;
  return { postalCode, countryCode };
}

/**
 * The subscription that produced an invoice, from whichever field this API
 * version puts it in. `null` means the invoice is not subscription-backed at all
 * (a one-off invoice), which is never one of ours.
 */
export function membershipInvoiceSubscriptionId(
  // The upcoming variant differs only in `id`, which this helper never reads.
  invoice: MembershipInvoice | MembershipUpcomingInvoice,
): string | null {
  return (
    invoice.parent?.subscription_details?.subscription ??
    invoice.subscription ??
    null
  );
}

/**
 * The originating subscription's metadata snapshot, from whichever field this
 * API version puts it in (Basil: `parent.subscription_details.metadata`;
 * pre-Basil: top-level `subscription_details.metadata`). `null` when the
 * payload carries none.
 *
 * `startMembership` stamps `tierId` + `memberHumanId` here at subscription
 * creation, so this is how the webhook recognises "our subscription whose
 * Membership row has not committed yet" — the first-invoice race, where Stripe
 * pays a no-trial first invoice INSIDE `subscriptions.create` and the event
 * can beat our own `memberships.create`.
 */
export function membershipInvoiceSubscriptionMetadata(
  invoice: MembershipInvoice | MembershipUpcomingInvoice,
): Record<string, string> | null {
  return (
    invoice.parent?.subscription_details?.metadata ??
    invoice.subscription_details?.metadata ??
    null
  );
}

/**
 * Exclusive tax on the invoice, in cents.
 *
 * ONLY exclusive entries. `subtotal` already contains inclusive tax, so summing
 * everything would charge the tax twice on the order and understate what the
 * owner is owed. Our membership TaxRates are created with `inclusive: false`
 * (see `ensureTaxRate`), so in practice every entry is exclusive — the filter is
 * there so a hand-created inclusive rate cannot silently corrupt the arithmetic.
 *
 * Legacy fallback: pre-Basil invoices carry `tax` (a plain integer) instead of
 * `total_taxes[]`. It is consulted ONLY when `total_taxes` is absent, and our
 * rates have always been exclusive, so treating the legacy sum as exclusive
 * cannot double-count for events we produced. When `total_taxes` IS present it
 * wins outright — it carries the per-entry `tax_behavior` the filter needs.
 */
export function membershipInvoiceExclusiveTaxCents(
  invoice: MembershipInvoice,
): number {
  if (invoice.total_taxes != null) {
    return invoice.total_taxes
      .filter((tax) => tax.tax_behavior !== "inclusive")
      .reduce((sum, tax) => sum + tax.amount, 0);
  }
  return invoice.tax ?? 0;
}

/** The PaymentIntent behind a paid invoice, when the payload carries one. */
export function membershipInvoicePaymentIntentId(
  invoice: MembershipInvoice,
): string | null {
  for (const payment of invoice.payments?.data ?? []) {
    const id = payment.payment?.payment_intent;
    if (id) return id;
  }
  return null;
}

/**
 * Billing period from `items.data[0]`, falling back to the LEGACY top-level
 * `current_period_start/end` (pre-Basil events carry the period there and have
 * no per-item copy). Null only when neither location has it — possible on a
 * `customer.subscription.deleted` for a subscription whose items were already
 * removed, in which case the mirror simply leaves the stored period untouched
 * rather than guessing one. The fallback matters beyond cosmetics: a null
 * period defeats `syncMembershipFromStripe`'s out-of-order guard, letting a
 * stale replayed `active` overwrite a newer state.
 */
export function membershipSubscriptionPeriod(
  subscription: MembershipSubscription,
): { start: Date | null; end: Date | null } {
  const item = subscription.items?.data?.[0];
  const startS = item?.current_period_start ?? subscription.current_period_start;
  const endS = item?.current_period_end ?? subscription.current_period_end;
  return {
    start: startS ? new Date(startS * 1000) : null,
    end: endS ? new Date(endS * 1000) : null,
  };
}
