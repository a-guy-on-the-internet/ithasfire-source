import type { MembershipBillingPort } from "@th/ports/membership-billing-port";
import type { Repos } from "@th/ports/repos";
import type { MembershipTaxJurisdictionRecord } from "@th/ports/repos/membership-tax-jurisdictions";

/**
 * The `default_tax_rates` list a subscription in this jurisdiction needs,
 * minting the Stripe TaxRate lazily on first use.
 *
 * Lazy on purpose (shared by `startMembership`, `updateMemberBillingAddress`
 * and `refreshTaxJurisdictions`): jurisdiction rows are created with
 * `stripeTaxRateId = null` so the row write never holds a two-phase commit
 * open across our DB and Stripe's API — the rate is minted here, the first
 * time a subscription actually references it. NOTE the refresh job calls this
 * eagerly right after a rate change when live subscriptions must be migrated
 * off the archived rate; "lazy" means the DB write is decoupled from the
 * Stripe mint, not that a mint always waits for member activity. The
 * idempotency key is keyed on the jurisdiction row, so concurrent first-users
 * cannot mint duplicates.
 *
 * An EMPTY result is a genuine 0% jurisdiction (Delaware, Montana, ...) — a
 * real answer, never a placeholder. Callers decide what empty means at their
 * Stripe call site (`createSubscription` omits the field; \
 * `updateSubscriptionTaxRates` must CLEAR existing rates).
 */
export async function ensureJurisdictionDefaultTaxRateIds(
  deps: { repos: Repos; membershipBilling: MembershipBillingPort },
  jurisdiction: MembershipTaxJurisdictionRecord,
): Promise<string[]> {
  if (jurisdiction.rateBps <= 0) return [];

  let taxRateId = jurisdiction.stripeTaxRateId;
  if (!taxRateId) {
    const created = await deps.membershipBilling.ensureTaxRate({
      jurisdictionId: jurisdiction.id,
      displayName: `Sales tax (${jurisdiction.postalCode})`,
      percentage: jurisdiction.rateBps / 100,
      inclusive: false,
      country: jurisdiction.countryCode,
      idempotencyKey: `membership-tax-rate:${jurisdiction.id}`,
    });
    taxRateId = created.taxRateId;
    await deps.repos.membershipTaxJurisdictions.attachStripeTaxRateId({
      id: jurisdiction.id,
      stripeTaxRateId: taxRateId,
    });
  }
  return [taxRateId];
}
