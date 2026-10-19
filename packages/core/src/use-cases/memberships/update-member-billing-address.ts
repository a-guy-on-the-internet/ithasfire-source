import { randomUUID } from "node:crypto";

import { z } from "zod";

import { fail, isAppError } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { MembershipBillingPort } from "@th/ports/membership-billing-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import type { Repos } from "@th/ports/repos";

import { asKnownError } from "../../lib/errors";
import { parseInput } from "../../lib/io";
import { abandonClaim } from "../../lib/idempotency-claim";
import { ensureJurisdictionDefaultTaxRateIds } from "./ensure-jurisdiction-tax-rate";
import { MEMBERSHIP_LIVE_STATUSES } from "./membership-status";
import { resolveMemberTaxJurisdiction } from "./resolve-member-tax-jurisdiction";

/**
 * Re-resolve a member's tax jurisdiction after a billing-address change.
 *
 * Driven by Stripe's `customer.updated` webhook (the hosted portal is where a
 * member edits their card's billing address — we have no form of our own).
 * Without this, a member who moves states keeps billing at the OLD
 * jurisdiction's TaxRate for the life of the subscription, and as merchant of
 * record the shortfall (or over-collection) is ours. This is the spec's
 * "Changing a member's billing address re-resolves their jurisdiction"
 * acceptance criterion.
 *
 * ONE Stripe Customer backs ALL of a member's memberships (platform-owned,
 * one card across every owner), so a single address change fans out to every
 * row on that customer.
 *
 * The per-row loop is NOT about the tax lookup. Every row resolves the SAME
 * jurisdiction — one (country, postal) in, the postal code's general rate out,
 * with no per-tier dimension — so the whole fan-out costs at most one provider
 * call and every row after the first is a cache hit. The loop exists because
 * each membership is its own Stripe subscription with its own status and its
 * own stored address: rows already at this address are skipped individually,
 * non-live rows are skipped individually, and each live subscription's
 * `default_tax_rates` has to be repointed by id. Collapsing it into one shared
 * resolution would save nothing and lose the per-row failure isolation below.
 *
 * Ordering per row is load-bearing: the LIVE subscription's
 * `default_tax_rates` is migrated on Stripe FIRST, the row second. Written
 * the other way round, a Stripe failure after the row commit would make the
 * webhook replay see the row as "already at the new address" and skip it —
 * the subscription would bill the old rate forever with nothing left to
 * retry. Stripe-first means any failure leaves the row on the old address, so
 * the DLQ replay redoes the whole row (the Stripe update is idempotent and
 * the jurisdiction is cached by then).
 *
 * FAIL-OPEN for unpriceable moves, deliberately — the opposite of signup.
 * Signup fails closed (we refuse to START selling into a place we cannot
 * price), but an EXISTING member moving somewhere unpriceable must not have a
 * live membership silently killed or its rate zeroed: this follows the
 * refresh job's stance that a provider failure is not evidence a jurisdiction
 * stopped taxing, so the last known-good rate keeps billing. Both failure
 * kinds are swallowed HERE (and both are reported):
 *
 *   - UNAVAILABLE: our outage on a live subscription — report, keep rate.
 *   - UNSUPPORTED: unlike at signup (where it is unreported non-US noise), a
 *     tracked member genuinely moving somewhere we cannot price is a rare,
 *     real business event an operator should see — a US-only product just
 *     acquired a non-US-resident member. Reported too, on purpose.
 *
 * `reportError` is deliberately NOT forwarded into the nested
 * `resolveMemberTaxJurisdiction` call: this use case owns the swallow, so it
 * owns the single report (with its own tags), rather than double-reporting
 * UNAVAILABLE.
 *
 * Rows that are NOT live (canceled, incomplete_expired, ...) are skipped: the
 * dead subscription cannot be updated on Stripe, its address no longer bills
 * anything, and a resume (`startMembership`) re-resolves everything fresh
 * anyway.
 *
 * Failure policy: repo and Stripe write failures THROW (the webhook DLQs the
 * event and a replay retries — nothing here is terminal); only the
 * per-row unchanged/not-live/unpriceable outcomes continue.
 */

const IDEMPOTENCY_KEY_TTL_SECONDS = 300;
const IDEMPOTENCY_KEEP_SECONDS = 86_400; // 24h retention

export const updateMemberBillingAddressInputSchema = z
  .object({
    stripeCustomerId: z.string().trim().min(3).max(255),
    billingCountryCode: z
      .string()
      .trim()
      .length(2)
      .transform((value) => value.toUpperCase()),
    billingPostalCode: z
      .string()
      .trim()
      .min(1)
      .max(16)
      .transform((value) => value.toUpperCase()),
    stripeEventId: z.string().trim().min(3).max(255),
  })
  .strict();

export type UpdateMemberBillingAddressInput = z.infer<
  typeof updateMemberBillingAddressInputSchema
>;

export const updateMemberBillingAddressOutputSchema = z
  .object({
    ok: z.literal(true),
    /** Rows tracked for this customer (any status). */
    memberships: z.number().int().nonnegative(),
    /** Rows whose subscription was migrated and whose row was re-pointed. */
    updated: z.number().int().nonnegative(),
    /** Rows already at this address — the hot path; costs no provider call. */
    unchanged: z.number().int().nonnegative(),
    /** Non-live rows left untouched (nothing bills; resume re-resolves). */
    skippedNotLive: z.number().int().nonnegative(),
    /** Rows left on their last known-good rate (reported, not thrown). */
    unpriceable: z.number().int().nonnegative(),
  })
  .strict();

export type UpdateMemberBillingAddressOutput = z.infer<
  typeof updateMemberBillingAddressOutputSchema
>;

export type UpdateMemberBillingAddressDeps = {
  repos: Repos;
  membershipBilling: MembershipBillingPort;
  taxRateLookup: TaxRateLookupPort;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

interface StoredAddressChangeRecord {
  response: UpdateMemberBillingAddressOutput;
  stripeCustomerId: string;
}

const LIVE_STATUSES: ReadonlySet<string> = new Set(MEMBERSHIP_LIVE_STATUSES);

/** Codes on which an EXISTING member keeps their last known-good rate. */
const UNPRICEABLE_CODES: ReadonlySet<string> = new Set([
  "TAX_JURISDICTION_UNSUPPORTED",
  "TAX_JURISDICTION_UNAVAILABLE",
]);

export async function updateMemberBillingAddress(
  deps: UpdateMemberBillingAddressDeps,
  rawInput: unknown,
): Promise<UpdateMemberBillingAddressOutput> {
  const input = parseInput(updateMemberBillingAddressInputSchema, rawInput);

  // Idempotent per EVENT id, same 5-step shape as
  // `recordMembershipInvoicePaid`: a Stripe redelivery replays the stored
  // response instead of re-running the fan-out. (A replay would be near-free
  // anyway — every row would read "unchanged" — but the cache also makes the
  // response describe what the ORIGINAL delivery did, which is what an
  // operator reading webhook logs wants.)
  const idempotencyKey = `membership_billing_address:${input.stripeEventId}`;

  const cached =
    await deps.idempotency.get<StoredAddressChangeRecord>(idempotencyKey);
  if (cached) {
    if (cached.stripeCustomerId !== input.stripeCustomerId) {
      throw fail("STRIPE_EVENT_CONFLICT");
    }
    deps.logger?.info("updateMemberBillingAddress.replay_cached", {
      stripeCustomerId: input.stripeCustomerId,
      stripeEventId: input.stripeEventId,
    });
    return cached.response;
  }

  // Owner token for `abandonClaim` (lib/idempotency-claim.ts explains why).
  const claimOwnerToken = randomUUID();
  const claimed = await deps.idempotency.begin(
    idempotencyKey,
    IDEMPOTENCY_KEY_TTL_SECONDS,
    claimOwnerToken,
  );
  if (!claimed) {
    const replay =
      await deps.idempotency.get<StoredAddressChangeRecord>(idempotencyKey);
    if (replay) {
      if (replay.stripeCustomerId !== input.stripeCustomerId) {
        throw fail("STRIPE_EVENT_CONFLICT");
      }
      return replay.response;
    }
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  try {
    const result = await applyAddressChange(deps, input);

    await deps.idempotency.commit<StoredAddressChangeRecord>(
      idempotencyKey,
      { response: result, stripeCustomerId: input.stripeCustomerId },
      IDEMPOTENCY_KEEP_SECONDS,
    );

    return result;
  } catch (error) {
    await abandonClaim(deps.idempotency, idempotencyKey, claimOwnerToken, error, {
      useCase: "updateMemberBillingAddress",
      logger: deps.logger ?? null,
      reportError: deps.reportError ?? null,
    });
    throw asKnownError("update_member_billing_address", error);
  }
}

async function applyAddressChange(
  deps: UpdateMemberBillingAddressDeps,
  input: UpdateMemberBillingAddressInput,
): Promise<UpdateMemberBillingAddressOutput> {
  const memberships = await deps.repos.memberships.listByStripeCustomerId(
    input.stripeCustomerId,
  );

  const result: UpdateMemberBillingAddressOutput = {
    ok: true,
    memberships: memberships.length,
    updated: 0,
    unchanged: 0,
    skippedNotLive: 0,
    unpriceable: 0,
  };

  for (const membership of memberships) {
    // Case-insensitive: `startMembership` persists the address as typed,
    // while this input is normalised to uppercase.
    const unchanged =
      (membership.billingPostalCode ?? "").toUpperCase() ===
        input.billingPostalCode &&
      (membership.billingCountryCode ?? "").toUpperCase() ===
        input.billingCountryCode;
    if (unchanged) {
      result.unchanged += 1;
      continue;
    }

    if (!LIVE_STATUSES.has(membership.status)) {
      // A dead subscription cannot be updated on Stripe and bills nothing;
      // a resume re-resolves the address wholesale (`resumeFromStripe`).
      result.skippedNotLive += 1;
      deps.logger?.info("membership.billing_address.skipped_not_live", {
        membershipId: membership.id,
        status: membership.status,
      });
      continue;
    }

    // No tier read here: the tier used to supply the tax category, and nothing
    // else on it affects this path. Re-reading it purely to assert the FK
    // resolves would cost a query per row and could only ever DLQ an otherwise
    // healthy address change over something unrelated to the address.

    let jurisdictionId: string;
    let defaultTaxRateIds: string[];
    try {
      const { jurisdiction, lookedUp } = await resolveMemberTaxJurisdiction(
        {
          repos: deps.repos,
          taxRateLookup: deps.taxRateLookup,
          clock: deps.clock,
          logger: deps.logger,
          // No reportError on purpose — the swallow below owns the report.
        },
        {
          countryCode: input.billingCountryCode,
          postalCode: input.billingPostalCode,
        },
      );
      deps.logger?.info("membership.billing_address.jurisdiction_resolved", {
        membershipId: membership.id,
        jurisdictionId: jurisdiction.id,
        rateBps: jurisdiction.rateBps,
        lookedUp,
      });
      jurisdictionId = jurisdiction.id;
      defaultTaxRateIds = await ensureJurisdictionDefaultTaxRateIds(
        { repos: deps.repos, membershipBilling: deps.membershipBilling },
        jurisdiction,
      );
    } catch (err) {
      if (isAppError(err) && UNPRICEABLE_CODES.has(err.code)) {
        // FAIL-OPEN (see header): a live membership keeps its last
        // known-good rate; the row keeps the OLD address so a later replay
        // or the next address change retries the resolution. warn is not
        // Sentry-captured, so the report is what makes this ops-visible.
        result.unpriceable += 1;
        deps.logger?.warn("membership.billing_address.unpriceable_move", {
          membershipId: membership.id,
          code: err.code,
          countryCode: input.billingCountryCode,
          postalCode: input.billingPostalCode,
        });
        deps.reportError?.(err, {
          tags: { useCase: "updateMemberBillingAddress", code: err.code },
          extra: {
            membershipId: membership.id,
            stripeCustomerId: input.stripeCustomerId,
            countryCode: input.billingCountryCode,
            postalCode: input.billingPostalCode,
          },
        });
        continue;
      }
      throw err;
    }

    // Stripe FIRST, row second — see the header note on ordering. Empty
    // rate list = genuine 0% jurisdiction; the port contract CLEARS rates.
    await deps.membershipBilling.updateSubscriptionTaxRates({
      subscriptionId: membership.stripeSubscriptionId,
      defaultTaxRateIds,
      // Keyed on (EVENT, membership) — the event is the true retry unit.
      // NOT (membership, jurisdiction): Stripe retains idempotency keys for
      // ~24h, so an A→B→A move within a day would make the return-to-A call
      // replay the cached original response WITHOUT touching the
      // subscription — Stripe keeps billing B while our row says A. A
      // redelivery of the SAME event replays the same key (and the
      // event-level guard above short-circuits it anyway); a re-apply under
      // a new event is safe because subscriptions.update is a full
      // replacement of default_tax_rates.
      idempotencyKey: `membership-sub-tax:${input.stripeEventId}:${membership.id}`,
    });

    await deps.repos.memberships.updateBillingAddress({
      id: membership.id,
      taxJurisdictionId: jurisdictionId,
      billingPostalCode: input.billingPostalCode,
      billingCountryCode: input.billingCountryCode,
    });

    result.updated += 1;
    deps.logger?.info("membership.billing_address.updated", {
      membershipId: membership.id,
      stripeSubscriptionId: membership.stripeSubscriptionId,
      taxJurisdictionId: jurisdictionId,
      defaultTaxRateCount: defaultTaxRateIds.length,
    });
  }

  return updateMemberBillingAddressOutputSchema.parse(result);
}
