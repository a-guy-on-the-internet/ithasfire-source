import type { GetPayeeBySubjectInput } from "@th/ports/repos/payees";
import type {
  PayoutSchedule,
  PayoutTermsRecord,
} from "@th/ports/repos/payout-terms";
import type { LoggerPort } from "@th/ports/logger";
import type { TxRepos } from "@th/ports/repos";

export type EntityPayoutSubject = {
  type: "ORGANIZATION" | "HUMAN";
  id: string;
};

export type EnsureEntityDefaultPrimaryTermsOptions = {
  /**
   * Payout schedule for a FRESHLY provisioned default row. Used ONLY when
   * this call actually provisions (e.g. the payout settings page setting a
   * schedule before any default exists). An existing default row is returned
   * unchanged — callers that need to CHANGE an existing row's schedule go
   * through the copy-on-write clone path (`updatePayoutSchedule`).
   */
  payoutSchedule?: PayoutSchedule;
};

/**
 * Ensure an entity (org / human) has a reusable DEFAULT PRIMARY payout-terms
 * agreement — a 100%-to-owner row pointed to by
 * `Organization.defaultPrimaryPayoutTermsId` / `Human.defaultPrimaryPayoutTermsId`.
 *
 * This row is the entity's *reusable* default. It is NEVER linked to an event:
 * the event-centric helper (`ensureDefaultPrimaryPayoutTerms`) provisions a
 * SEPARATE event-owned row so that editing an event's splits via the dynamic
 * agreement builder can never mutate the entity's shared default.
 *
 * Behaviour (all inside the caller's transaction, idempotent):
 *  - If the entity already has `defaultPrimaryPayoutTermsId`, returns that row
 *    unchanged (no-op).
 *  - Resolves the entity's Payee. If there is NO payee, or it is not ACTIVE, or
 *    it does not have `payoutsEnabled`, returns `null` — we never fabricate a
 *    default for an entity that can't actually receive payouts.
 *  - Otherwise provisions an ACTIVE PRIMARY PayoutTerms (`isDefault: true`) with
 *    one 100% owner line, persists the entity default pointer, audit-logs, and
 *    returns it.
 *
 * Returns the entity default agreement (newly created or pre-existing), or
 * `null` when no usable payee exists.
 */
export async function ensureEntityDefaultPrimaryTerms(
  tx: TxRepos,
  subject: EntityPayoutSubject,
  now: Date,
  logger?: LoggerPort,
  options?: EnsureEntityDefaultPrimaryTermsOptions,
): Promise<PayoutTermsRecord | null> {
  // Idempotency: if the entity already has a default, return it unchanged.
  const existingDefaultId = await getEntityDefaultPrimaryId(tx, subject);
  if (existingDefaultId) {
    const existing = await tx.payoutTerms.getById(existingDefaultId);
    if (existing) {
      return existing;
    }
    // Dangling pointer (default row deleted) — fall through and re-provision.
  }

  const payeeRef = await tx.payees.getBySubject(
    subject satisfies GetPayeeBySubjectInput,
  );
  if (!payeeRef) {
    return null;
  }

  const payee = await tx.payees.getById(payeeRef.id);
  if (!payee || payee.status !== "ACTIVE" || !payee.payoutsEnabled) {
    // No usable payout target — don't fabricate a default.
    return null;
  }

  const terms = await tx.payoutTerms.provisionDefaultPrimary({
    payeeId: payee.id,
    settlementCurrency: payee.defaultCurrency ?? "usd",
    isDefault: true,
    // Only set when requested so the schema default applies otherwise.
    ...(options?.payoutSchedule !== undefined
      ? { payoutSchedule: options.payoutSchedule }
      : {}),
  });

  if (existingDefaultId) {
    // Dangling-pointer repair: the pointer is non-null but unresolvable, so
    // the IS-NULL CAS below cannot apply. Unconditional repair (pre-existing
    // behavior for this corrupted-state path).
    await setEntityDefaultPrimary(tx, subject, terms.id);
  } else {
    // Guarded pointer write: only lands while the pointer is still NULL.
    // Two concurrent provisioners (e.g. a settings-save updatePayoutSchedule
    // racing a first-publish auto-provision) can both read NULL at READ
    // COMMITTED and both mint an `isDefault: true` row; without the CAS the
    // last pointer write silently reverts the other transaction's choice and
    // strands its row as an unpointed default.
    const won = await setEntityDefaultPrimaryIfNull(tx, subject, terms.id);
    if (!won) {
      // Lost the race: adopt the winner's row and retire ours so no
      // `isDefault: true` orphan survives.
      const winnerId = await getEntityDefaultPrimaryId(tx, subject);
      const winner = winnerId
        ? await tx.payoutTerms.getById(winnerId)
        : null;
      if (winner) {
        await tx.payoutTerms.markNotDefault(terms.id);
        logger?.info("entity_default_primary_provision_race_lost", {
          ownerKind: subject.type,
          ownerId: subject.id,
          loserPayoutTermsId: terms.id,
          winnerPayoutTermsId: winner.id,
        });
        return winner;
      }
      // Defensive: the CAS missed but the re-read can't resolve a winner row
      // (pointer cleared or dangling mid-race). Repair with our row rather
      // than leaving the entity with no usable default.
      await setEntityDefaultPrimary(tx, subject, terms.id);
    }
  }

  await tx.audit.log({
    entity: "payoutTerms",
    entityId: terms.id,
    action: "created",
    data: {
      reason: "auto_provisioned_entity_default_primary",
      ownerKind: subject.type,
      ownerId: subject.id,
      payeeId: payee.id,
    },
    at: now,
  });

  logger?.info("auto_provisioned_entity_default_primary_payout_terms", {
    payoutTermsId: terms.id,
    ownerKind: subject.type,
    ownerId: subject.id,
  });

  return terms;
}

/**
 * Resolve the payout schedule of an entity's default PRIMARY payout terms,
 * or `null` when the entity has no (resolvable) default. Read-only — never
 * provisions. Used by event-level draft creation (`updateEventSplits`) so
 * fresh event-owned PRIMARY drafts inherit the
 * org/human default schedule instead of silently falling back to the schema
 * default.
 */
export async function getEntityDefaultPayoutSchedule(
  tx: TxRepos,
  subject: EntityPayoutSubject,
): Promise<PayoutSchedule | null> {
  const defaultId = await getEntityDefaultPrimaryId(tx, subject);
  if (!defaultId) {
    return null;
  }
  const terms = await tx.payoutTerms.getById(defaultId);
  return terms?.payoutSchedule ?? null;
}

async function getEntityDefaultPrimaryId(
  tx: TxRepos,
  subject: EntityPayoutSubject,
): Promise<string | null> {
  if (subject.type === "ORGANIZATION") {
    const org = await tx.organizations.getById(subject.id);
    return org?.defaultPrimaryPayoutTermsId ?? null;
  }
  const human = await tx.humans.getById(subject.id);
  return human?.defaultPrimaryPayoutTermsId ?? null;
}

/**
 * Guarded pointer write: sets `defaultPrimaryPayoutTermsId` only while it is
 * still NULL. Returns `false` on a 0-match (a concurrent transaction won).
 */
async function setEntityDefaultPrimaryIfNull(
  tx: TxRepos,
  subject: EntityPayoutSubject,
  payoutTermsId: string,
): Promise<boolean> {
  if (subject.type === "ORGANIZATION") {
    return tx.organizations.setDefaultPrimaryPayoutTermsIdIfNull({
      id: subject.id,
      payoutTermsId,
    });
  }
  return tx.humans.setDefaultPrimaryPayoutTermsIdIfNull({
    id: subject.id,
    payoutTermsId,
  });
}

async function setEntityDefaultPrimary(
  tx: TxRepos,
  subject: EntityPayoutSubject,
  payoutTermsId: string,
): Promise<void> {
  if (subject.type === "ORGANIZATION") {
    await tx.organizations.update({
      id: subject.id,
      defaultPrimaryPayoutTermsId: payoutTermsId,
    });
    return;
  }
  await tx.humans.update(subject.id, {
    defaultPrimaryPayoutTermsId: payoutTermsId,
  });
}
