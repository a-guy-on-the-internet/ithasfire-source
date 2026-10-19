import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES, requireOrgMembership } from "../../lib/rbac";
import {
  MANUAL_EVENT_TAX_RATE_MAX_BPS,
  MANUAL_EVENT_TAX_RATE_SOURCE,
  manualEventTaxRateBps,
} from "../../lib/tax/manual-event-tax-rate";
import {
  probeEventTaxRateOnce,
  TAX_LOOKUP_RETRY_BUDGET_MS,
} from "../orders/_shared/resolve-checkout-tax-rate";
import { assertDoorSellsEvent } from "../pos/_shared/door-event-gate";
import { markForSearchReindex } from "../search/search-reindex-marks";
import {
  eventTaxRateLocationRef,
  taxSitusRefKey,
} from "./_shared/resolve-event-tax-rate";

/**
 * Enter an event's sales-tax rate by hand when the tax provider cannot answer
 * (owner ruling R5; spec docs/specs/2026-10-07/door-sales-same-price-and-tax
 * FR-007). The door refuses a sale with TAX_RATE_UNAVAILABLE rather than
 * charge 0%; this is the way past that refusal.
 *
 * Lives with the event use cases because what it writes is the EVENT's tax
 * stamp — the same columns publish, save and the settings re-stamp write —
 * under the event's edit roles. The door only reads the stamp.
 *
 * - WHO: an Owner, Admin or Editor of the event's org (`ORG_EDIT_ROLES`).
 *   A Scanner sells at the door but may not set the rate.
 * - WHICH EVENTS: published, org-owned (the events the door sells), with a
 *   tax location, and no rate yet or a rate entered by hand before — AND
 *   only while the lookup is actually failing. One live attempt runs before
 *   the transaction, the same read a sale does: the venue's cached rate
 *   first, then the provider. Any answer (a rate, or "no rate here") refuses
 *   the entry, so a rate the provider or the venue can give — stamped on the
 *   event or not — is never overridden by a person.
 * - WHAT: `admissionTaxRateBps` (basis points, as every stamp) with
 *   `taxRateSource` {@link MANUAL_EVENT_TAX_RATE_SOURCE}; who and when go on
 *   an audit row (`event_manual_tax_rate_set`). Every surface that reads the
 *   stamp charges it, online checkout included, until a successful lookup
 *   replaces it (`prepareCheckoutTax`).
 * - ALERT: reported to the platform on every entry that changes the stamp.
 *   The same rate again is a no-op: no write, no report.
 */
export const setManualEventTaxRateInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    /**
     * Basis points: 1 bps = 0.01%, so 9.25% is 925. Whole basis points from 0
     * to {@link MANUAL_EVENT_TAX_RATE_MAX_BPS} (25%). Zero is allowed: a place
     * with no sales tax is real, and the entry is reported either way.
     */
    rateBps: z.number().int().min(0).max(MANUAL_EVENT_TAX_RATE_MAX_BPS),
  })
  .strict();

export const setManualEventTaxRateOutputSchema = z.object({
  eventId: z.uuid(),
  admissionTaxRateBps: z.number().int().nonnegative(),
  taxRateSource: z.literal(MANUAL_EVENT_TAX_RATE_SOURCE),
  /** `false` when the event already carried this exact manual rate. */
  changed: z.boolean(),
});

export type SetManualEventTaxRateInput = z.infer<
  typeof setManualEventTaxRateInputSchema
>;
export type SetManualEventTaxRateOutput = z.infer<
  typeof setManualEventTaxRateOutputSchema
>;

export type SetManualEventTaxRateDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * The platform alert (owner ruling R5). Called after the commit, guarded:
   * a throwing reporter never changes the result.
   */
  reportError?: ReporterPort;
  /**
   * The tax provider. One attempt runs BEFORE the transaction to confirm the
   * lookup is actually failing. Null/absent = no provider configured, and
   * entry is refused (`lookup_not_configured`).
   */
  taxRateLookup?: TaxRateLookupPort | null;
};

export async function setManualEventTaxRate(
  deps: SetManualEventTaxRateDeps,
  rawInput: unknown,
): Promise<SetManualEventTaxRateOutput> {
  const input = parseInput(setManualEventTaxRateInputSchema, rawInput);
  const now = deps.clock.now();
  const unchanged = (orgId: string): SetManualEventTaxRateOutput => {
    deps.logger?.info("manual_tax_rate_unchanged", {
      eventId: input.eventId,
      orgId,
      rateBps: input.rateBps,
      actorHumanId: input.actorHumanId,
    });
    return {
      eventId: input.eventId,
      admissionTaxRateBps: input.rateBps,
      taxRateSource: MANUAL_EVENT_TAX_RATE_SOURCE,
      changed: false,
    };
  };

  // ── Phase 0: role and event, on plain reads, BEFORE the lookup ─────────
  // The lookup below can be a paid provider call: nothing may spend it for a
  // caller or an event the entry would refuse anyway. A stranger also learns
  // nothing about the event's state.
  const before = await deps.repos.events.getById(input.eventId);
  if (!before) throw fail("EVENT_NOT_FOUND");
  if (!before.orgId) throw fail("EVENT_NOT_ORG_OWNED");
  const orgId = before.orgId;
  await requireOrgMembership({
    repos: deps.repos,
    orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_EDIT_ROLES,
  });
  const { ref, previousManualBps } = assertEntryAllowed(before);
  if (previousManualBps === input.rateBps) return unchanged(orgId);

  // ── Phase 1: is the lookup actually failing? (NFR-002: not in a tx) ────
  // The same read a sale does — the venue's cached rate first, then the
  // provider — once, within a sale's full lookup budget (a shorter gate would
  // let a slow but working provider count as failing). A person may enter a
  // rate only while it fails: an answer (a rate, or "no rate here") means the
  // next sale prices without a hand-entered rate, so there is nothing to get
  // past. Refused rather than stamped: the sale's own path resolves, stamps
  // and caches that answer (exemption, compare-and-set, cache fill), and
  // duplicating it here would be a second copy of the money path.
  const probe = await probeEventTaxRateOnce(
    {
      repos: deps.repos,
      taxRateLookup: deps.taxRateLookup,
      clock: deps.clock,
      reportError: deps.reportError,
    },
    ref,
    input.eventId,
    deps.logger,
    "manual_entry",
    TAX_LOOKUP_RETRY_BUDGET_MS,
  );
  if (probe.kind === "answered") {
    throw fail("MANUAL_TAX_RATE_NOT_ALLOWED", {
      message: "manual_tax_rate_lookup_answers",
      meta: {
        reason: "lookup_available",
        lookedUpRateBps: probe.prepared.stamp?.rateBps ?? null,
      },
    });
  }
  if (probe.kind === "not_looked_up") {
    // No provider in this deployment: a sale never refuses for a failed
    // lookup (it prices from the venue cache, else at "no rate"), so there is
    // nothing to get past — and a hand-entered rate could never be replaced.
    throw fail("MANUAL_TAX_RATE_NOT_ALLOWED", {
      message: "manual_tax_rate_no_provider",
      meta: { reason: "lookup_not_configured" },
    });
  }

  // ── Phase 2: the entry, decided again on the locked row ───────────────
  const result = await deps.repos.tx(async (tx) => {
    await requireOrgMembership({
      repos: tx,
      orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_EDIT_ROLES,
    });
    // FOR UPDATE, then decide on the locked row: a settings save, a venue
    // change or a sale's replacement of a manual stamp committed meanwhile
    // is what this entry is checked against. No place lock is needed: nothing
    // here reads the venue's rate.
    await tx.events.lockRows({ ids: [input.eventId], mode: "update" });
    const event = await tx.events.getById(input.eventId);
    if (!event) throw fail("EVENT_NOT_FOUND");
    if (event.orgId !== orgId) throw fail("INSUFFICIENT_ROLE");
    const locked = assertEntryAllowed(event);
    if (taxSitusRefKey(locked.ref) !== taxSitusRefKey(ref)) {
      // The venue moved since the lookup above: that answer is for another
      // address. Refused; the Editor retries against the new one.
      throw fail("MANUAL_TAX_RATE_NOT_ALLOWED", {
        message: "manual_tax_rate_location_changed",
        meta: { reason: "location_changed" },
      });
    }
    if (locked.previousManualBps === input.rateBps) {
      return { previousBps: locked.previousManualBps, changed: false };
    }

    const previous = {
      rateBps: event.admissionTaxRateBps ?? null,
      source: event.taxRateSource ?? null,
    };
    await tx.events.updateTaxRate({
      eventId: event.id,
      admissionTaxRateBps: input.rateBps,
      taxRateSource: MANUAL_EVENT_TAX_RATE_SOURCE,
    });
    // WHO and WHEN: the audit row is the record of the entry.
    await tx.audit.log({
      entity: "event",
      entityId: event.id,
      action: "event_manual_tax_rate_set",
      data: {
        eventId: event.id,
        orgId,
        actorHumanId: input.actorHumanId,
        rateBps: input.rateBps,
        previousRateBps: previous.rateBps,
        previousSource: previous.source,
      },
      at: now,
    });
    // Listing cards quote an all-in price built from the event's rate
    // (`listing-buyer-totals.ts`). Marked in the same transaction as the
    // stamp, as every marking write path does: a failed mark fails the write
    // rather than leave a card quoting the old rate.
    await markForSearchReindex(tx, [{ kind: "event", id: event.id }], now);
    return { previousBps: locked.previousManualBps, changed: true };
  });
  if (!result.changed) return unchanged(orgId);

  const extra = {
    eventId: input.eventId,
    orgId,
    rateBps: input.rateBps,
    previousManualRateBps: result.previousBps,
    actorHumanId: input.actorHumanId,
    enteredAt: now.toISOString(),
    lookupProviderCode: probe.failure.providerCode,
    lookupHttpStatus: probe.failure.httpStatus,
    lookupBudgetExhausted: probe.budgetExhausted,
  };
  // The platform alert (R5): a person, not the provider, set what every sale
  // of this event now charges.
  try {
    deps.reportError?.(new Error("manual_tax_rate_entered"), {
      tags: {
        area: "tax",
        kind: "manual_rate_entered",
        useCase: "setManualEventTaxRate",
      },
      extra,
    });
  } catch {
    // A throwing reporter must never change the result.
  }
  deps.logger?.info("manual_tax_rate_entered", extra);

  return {
    eventId: input.eventId,
    admissionTaxRateBps: input.rateBps,
    taxRateSource: MANUAL_EVENT_TAX_RATE_SOURCE,
    changed: true,
  };
}

/**
 * The entry's event-side rules, checked on the plain read and again on the
 * locked row: published (the door's gate), not rated by the provider or the
 * venue, and with a tax location to look up.
 */
function assertEntryAllowed(
  event: Parameters<typeof eventTaxRateLocationRef>[0] & {
    status: string;
    admissionTaxRateBps?: number | null;
    taxRateSource?: string | null;
  },
): {
  ref: NonNullable<ReturnType<typeof eventTaxRateLocationRef>>;
  previousManualBps: number | null;
} {
  assertDoorSellsEvent(event);
  const previousManualBps = manualEventTaxRateBps(event);
  if (event.admissionTaxRateBps != null && previousManualBps == null) {
    throw fail("MANUAL_TAX_RATE_NOT_ALLOWED", {
      message: "manual_tax_rate_event_already_has_a_rate",
      meta: { reason: "rate_resolved" },
    });
  }
  const ref = eventTaxRateLocationRef(event);
  if (!ref) {
    throw fail("MANUAL_TAX_RATE_NOT_ALLOWED", {
      message: "manual_tax_rate_event_has_no_location",
      meta: { reason: "no_location" },
    });
  }
  return { ref, previousManualBps };
}
