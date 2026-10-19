import type { EventRecord } from "@th/ports/repos/events";
import type { GetPayeeBySubjectInput } from "@th/ports/repos/payees";
import type { PayoutTermsRecord } from "@th/ports/repos/payout-terms";
import type { LoggerPort } from "@th/ports/logger";
import type { TxRepos } from "@th/ports/repos";

import {
  ensureEntityDefaultPrimaryTerms,
  type EntityPayoutSubject,
} from "./ensure-entity-default-primary-terms";

/**
 * Auto-provision a sensible default PRIMARY payout-terms agreement for an
 * event whose owner has never configured one.
 *
 * Background: publishing a paid event requires a PRIMARY PayoutTerms linked via
 * `Event.payoutTermsId`, with at least one line and a resolvable fee policy.
 * Outside the seed script nothing ever creates the owner's
 * `defaultPrimaryPayoutTermsId`, so real orgs/humans publish into a hard
 * `primary_agreement_missing` error. This helper closes that gap by creating a
 * default 100%-to-owner agreement on demand.
 *
 * Builder-safety: this helper fills the gap ONLY for events that have no
 * PRIMARY payout terms at all. If the event ALREADY links a PRIMARY row — in
 * ANY status, including a PENDING draft authored by the dynamic agreement
 * builder (`updateEventSplits`) — this returns that
 * row UNCHANGED. It never re-links, duplicates, or clobbers builder-authored
 * agreements.
 *
 * Behaviour (all inside the caller's transaction, idempotent):
 *  - If the event already links a PRIMARY agreement (any status), returns it
 *    unchanged.
 *  - Otherwise resolves the owner subject from the event (org vs human) and
 *    looks up the owner's Payee. If there is NO payee, or it is not ACTIVE, or
 *    it does not have `payoutsEnabled`, returns `null` — the caller falls
 *    through to its existing `primary_agreement_missing` error rather than
 *    fabricating one.
 *  - Otherwise:
 *      1. Ensures the entity-level reusable default exists
 *         (`ensureEntityDefaultPrimaryTerms`). That default row is NEVER linked
 *         to an event.
 *      2. Creates a SEPARATE event-owned PRIMARY row (`isDefault: false`) with
 *         one 100% owner line and links it to the event via `linkPayoutTerms`.
 *
 * The entity default and the event row are independent 100%-to-owner rows: the
 * event row is what publish uses and what event-level editing may later mutate;
 * the entity default stays pristine and reusable.
 *
 * The provisioned line is a plain owner line (`requiresConfirmation = false`),
 * so it bypasses the splits-spec publish gates and flows through the existing
 * single-owner-line publish path. The fee policy is left unpinned here;
 * `publishEvent` resolves EVENT → ORG → GLOBAL (`resolveScopedFeePolicy`)
 * and pins the result.
 *
 * Returns the event-owned PRIMARY agreement (newly created or pre-existing), or
 * `null` when no usable payee exists.
 */
export async function ensureDefaultPrimaryPayoutTerms(
  tx: TxRepos,
  event: EventRecord,
  now: Date,
  logger?: LoggerPort,
): Promise<PayoutTermsRecord | null> {
  // Builder-safety + idempotency: if the event already links ANY PRIMARY terms
  // row (ACTIVE or a PENDING builder draft), do nothing and return it. This is
  // the single guard that prevents auto-provision from ever touching a
  // builder-authored agreement — we only fill the gap for events with no
  // PRIMARY terms at all.
  const existingPrimary = await findLinkedPrimary(tx, event);
  if (existingPrimary) {
    return existingPrimary;
  }

  const subject = derivePayeeSubject(event);
  if (!subject) {
    return null;
  }

  const payeeRef = await tx.payees.getBySubject(subject);
  if (!payeeRef) {
    return null;
  }

  const payee = await tx.payees.getById(payeeRef.id);
  if (!payee || payee.status !== "ACTIVE" || !payee.payoutsEnabled) {
    // No usable payout target — let the caller surface the original error.
    return null;
  }

  // Step 1: ensure the entity's reusable default exists. This row is NEVER
  // event-linked, so event-level editing can't mutate the shared default.
  const entityDefault = await ensureEntityDefaultPrimaryTerms(
    tx,
    subject,
    now,
    logger,
  );

  // Step 2: create a SEPARATE event-owned row (isDefault: false) and link it.
  // The event row inherits the entity default's payout schedule so the
  // schedule chosen on the payout settings page genuinely flows into events.
  // `entityDefault` should always exist here (the payee checks above mirror
  // the helper's own bail conditions), but stay defensive: when it is null
  // the schema default applies.
  const terms = await tx.payoutTerms.provisionDefaultPrimary({
    payeeId: payee.id,
    settlementCurrency: payee.defaultCurrency ?? "usd",
    isDefault: false,
    ...(entityDefault
      ? { payoutSchedule: entityDefault.payoutSchedule }
      : {}),
  });

  await tx.events.linkPayoutTerms({
    eventId: event.id,
    payoutTermsId: terms.id,
    kind: "PRIMARY",
  });

  await tx.audit.log({
    entity: "payoutTerms",
    entityId: terms.id,
    action: "created",
    data: {
      reason: "auto_provisioned_default_primary",
      eventId: event.id,
      ownerKind: subject.type,
      ownerId: subject.id,
      payeeId: payee.id,
    },
    at: now,
  });

  logger?.info("auto_provisioned_default_primary_payout_terms", {
    eventId: event.id,
    payoutTermsId: terms.id,
    ownerKind: subject.type,
    ownerId: subject.id,
  });

  return terms;
}

/**
 * Resolve the PRIMARY payout-terms row linked to the event, in ANY status.
 * Checks `Event.payoutTermsId` directly (via `listByEvent`, which resolves the
 * event's `payoutTermsId` / `resalePayoutTermsId` FKs).
 */
async function findLinkedPrimary(
  tx: TxRepos,
  event: EventRecord,
): Promise<PayoutTermsRecord | null> {
  const linked = await tx.payoutTerms.listByEvent(event.id);
  return linked.find((t) => t.kind === "PRIMARY") ?? null;
}

function derivePayeeSubject(event: EventRecord): EntityPayoutSubject | null {
  if (event.orgId) {
    return { type: "ORGANIZATION", id: event.orgId };
  }
  if (event.humanId) {
    return { type: "HUMAN", id: event.humanId };
  }
  return null;
}

// Keep the legacy import-site type re-export stable for callers that referenced
// the subject shape from this module.
export type { GetPayeeBySubjectInput };
