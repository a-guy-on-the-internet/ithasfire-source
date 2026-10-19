import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import type { Repos } from "@th/ports/repos";
import type { MembershipTaxJurisdictionRecord } from "@th/ports/repos/membership-tax-jurisdictions";

import { parseInput } from "../../lib/io";

/**
 * Map a member's billing address to a cached tax jurisdiction.
 *
 * Membership tax is DESTINATION-sourced — the member's address, not the
 * owner's and not a venue's. (Ticket tax is the opposite: admissions source to
 * where the event happens, which is why the ticketing path stamps a rate on the
 * Event instead.)
 *
 * The cache is keyed on the PLACE, not the person, so the second member in a
 * postal code costs no provider call at all. That is what keeps ZipTax volume
 * flat as membership count grows, and it is why this returns a shared row
 * rather than copying a rate onto each Membership.
 *
 * ONE rate per (country, postal) — the GENERAL rate, with no product-category
 * dimension. US taxability really does vary by what is sold (digital goods vs
 * admissions vs tangible property), but `lookupByPostalCode` accepts only
 * `{postalCode, countryCode}` and answers with a single rate, so a category
 * could never have changed the number. Carrying one only fragmented this cache
 * into N rows and N provider calls per postal code while implying a taxability
 * determination nobody actually made. If we ever buy a provider that resolves
 * by category, the port signature changes first and the key follows it.
 *
 * FAILS CLOSED. If we cannot price a jurisdiction we do not sell into it.
 *
 * This is the opposite of the ticketing path, where `resolveCheckoutTax`
 * degrades to a 0 rate rather than block a checkout — and the difference is
 * deliberate. We are merchant of record, so tax we fail to collect is tax WE
 * owe. A ticket is a single charge and a one-off shortfall; a membership bills
 * again every period, so a silently-zeroed rate compounds a liability on our
 * own books for as long as the subscription lives. Refusing the signup is
 * cheaper than discovering it at registration time.
 *
 * Two distinct failures, kept apart because they need different responses:
 *   * UNSUPPORTED — the provider answered, and does not know this place. A
 *     normal business rejection (ZipTax is US-only, so this is every non-US
 *     address today). Not reported to Sentry; retrying changes nothing.
 *   * UNAVAILABLE — the provider errored. Our outage, worth reporting and
 *     worth retrying.
 *
 * Note a genuine 0% jurisdiction is NOT a failure: Delaware, Montana, New
 * Hampshire and Oregon levy no state sales tax, and a provider answering
 * "0" for them is a correct answer that caches like any other.
 */

export const resolveMemberTaxJurisdictionInputSchema = z
  .object({
    countryCode: z
      .string()
      .trim()
      .length(2)
      .transform((value) => value.toUpperCase()),
    postalCode: z
      .string()
      .trim()
      .min(1)
      .max(16)
      .transform((value) => value.toUpperCase()),
  })
  .strict();

/**
 * Stamp on every membership jurisdiction row we write.
 *
 * NOTHING BRANCHES ON THIS. Nothing reads a membership jurisdiction's
 * `rateSource` except the adapter copying it into the DTO — its real consumer
 * is a human staring at a row months later asking "where did this number come
 * from, and what was it a rate FOR?". The `:general` suffix answers the second:
 * these rows carry the postal code's general rate, not a category-specific
 * determination, so a future reader cannot mistake a cached number for tax
 * advice we never gave. (The ticket-side `rateSource` means something else
 * entirely — admissions situs — which is why this lives here and not shared.)
 *
 * One helper rather than the literal inlined at both write sites so the two
 * cannot drift apart and make the same row look like two different provenances.
 */
export function membershipRateSource(providerSource: string): string {
  return `${providerSource}:general`;
}

export type ResolveMemberTaxJurisdictionInput = z.infer<
  typeof resolveMemberTaxJurisdictionInputSchema
>;

export type ResolveMemberTaxJurisdictionDeps = {
  repos: Repos;
  taxRateLookup: TaxRateLookupPort;
  clock: ClockPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

export type ResolveMemberTaxJurisdictionOutput = {
  jurisdiction: MembershipTaxJurisdictionRecord;
  /** True when this call hit the provider rather than the cache. */
  lookedUp: boolean;
};

export async function resolveMemberTaxJurisdiction(
  deps: ResolveMemberTaxJurisdictionDeps,
  rawInput: unknown,
): Promise<ResolveMemberTaxJurisdictionOutput> {
  const input = parseInput(resolveMemberTaxJurisdictionInputSchema, rawInput);

  const cached = await deps.repos.membershipTaxJurisdictions.findLive(input);
  if (cached) {
    return { jurisdiction: cached, lookedUp: false };
  }

  const now = deps.clock.now();

  let looked_up: { rateBps: number; source: string } | null;
  try {
    looked_up = await deps.taxRateLookup.lookupByPostalCode({
      postalCode: input.postalCode,
      countryCode: input.countryCode,
    });
  } catch (err) {
    // Our outage, not the member's problem — report it, then refuse rather
    // than guess. Guessing here would mean billing at a rate we invented.
    deps.reportError?.(err, {
      tags: { useCase: "resolveMemberTaxJurisdiction" },
      extra: {
        countryCode: input.countryCode,
        postalCode: input.postalCode,
      },
    });
    deps.logger?.error("membership.tax.lookup_failed", { err });
    throw fail("TAX_JURISDICTION_UNAVAILABLE", {
      meta: {
        countryCode: input.countryCode,
        postalCode: input.postalCode,
      },
    });
  }

  if (!looked_up) {
    // The provider answered and does not cover this place. A normal rejection,
    // not an incident, so it is logged rather than reported — Sentry noise for
    // every non-US signup attempt would bury real failures.
    deps.logger?.warn("membership.tax.jurisdiction_unsupported", {
      countryCode: input.countryCode,
      postalCode: input.postalCode,
    });
    throw fail("TAX_JURISDICTION_UNSUPPORTED", {
      meta: {
        countryCode: input.countryCode,
        postalCode: input.postalCode,
      },
    });
  }

  // Nothing unpriceable is ever cached: a row exists only when we know what to
  // charge. A rateBps of 0 here is a real answer from a real no-sales-tax
  // jurisdiction, not a placeholder for "we gave up".
  const jurisdiction = await deps.repos.membershipTaxJurisdictions.create({
    ...input,
    rateBps: looked_up.rateBps,
    rateSource: membershipRateSource(looked_up.source),
    checkedAt: now,
  });

  return { jurisdiction, lookedUp: true };
}
