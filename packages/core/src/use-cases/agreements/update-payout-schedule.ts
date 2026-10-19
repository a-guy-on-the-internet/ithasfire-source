import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { requireOrgMembership, ORG_FINANCE_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";
import { ensureEntityDefaultPrimaryTerms } from "./_shared/ensure-entity-default-primary-terms";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const PAYOUT_SCHEDULE_VALUES = [
  "ASAP",
  "WEEK_OF_EVENT",
  "ONE_WEEK_AFTER",
  "TWO_WEEKS_AFTER",
  "FOUR_WEEKS_AFTER",
] as const;

const entitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("org"), orgId: z.uuid() }),
  z.object({ kind: z.literal("human"), humanId: z.uuid() }),
]);

export const updatePayoutScheduleInputSchema = z.object({
  actorHumanId: z.uuid(),
  entity: entitySchema,
  payoutSchedule: z.enum(PAYOUT_SCHEDULE_VALUES),
});

export const updatePayoutScheduleInputSchemaBase =
  updatePayoutScheduleInputSchema;

export type UpdatePayoutScheduleInput = z.infer<
  typeof updatePayoutScheduleInputSchema
>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export const updatePayoutScheduleOutputSchema = z.object({
  payoutTermsId: z.string(),
  payoutSchedule: z.enum(PAYOUT_SCHEDULE_VALUES),
});

export type UpdatePayoutScheduleOutput = z.infer<
  typeof updatePayoutScheduleOutputSchema
>;

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export type UpdatePayoutScheduleDeps = {
  repos: Repos;
  logger?: LoggerPort;
  /** Injectable clock for tests; defaults to `new Date()` at call time. */
  now?: Date;
};

// ---------------------------------------------------------------------------
// Use case
// ---------------------------------------------------------------------------

export async function updatePayoutSchedule(
  deps: UpdatePayoutScheduleDeps,
  rawInput: unknown,
): Promise<UpdatePayoutScheduleOutput> {
  const input = updatePayoutScheduleInputSchema.parse(rawInput);
  const now = deps.now ?? new Date();

  return await deps.repos.tx(async (tx) => {
    // Resolve the source PayoutTerms id and a callback that re-points the
    // owning entity at the cloned terms. Branches keep their auth checks
    // local — orgs require finance-role membership; humans must operate on
    // their own row.
    let sourcePayoutTermsId: string;
    let entityLogContext: Record<string, string>;
    let repointDefault: (newPayoutTermsId: string) => Promise<void>;
    /** The entity's default pointer as committed now (re-read under the lock). */
    let readDefaultPointer: () => Promise<string | null>;

    if (input.entity.kind === "org") {
      const orgId = input.entity.orgId;
      const org = await tx.organizations.getById(orgId);
      if (!org)
        throw fail("ORGANIZATION_NOT_FOUND");
      if (org.status !== "ACTIVE") {
        throw fail("ORGANIZATION_INACTIVE");
      }

      await requireOrgMembership({
        repos: tx,
        orgId,
        actorHumanId: input.actorHumanId,
        roles: ORG_FINANCE_ROLES,
        errorCode: "INSUFFICIENT_ROLE",
      });

      if (org.defaultPrimaryPayoutTermsId) {
        sourcePayoutTermsId = org.defaultPrimaryPayoutTermsId;
      } else {
        // No default yet (normally minted at first publish): provision it on
        // demand so the schedule is manageable before any event exists. Born
        // with the requested schedule, so the fast path below returns it
        // without a pointless clone.
        const provisioned = await ensureEntityDefaultPrimaryTerms(
          tx,
          { type: "ORGANIZATION", id: orgId },
          now,
          deps.logger,
          { payoutSchedule: input.payoutSchedule },
        );
        if (!provisioned) {
          // No usable payee (Stripe payout onboarding incomplete) — we never
          // fabricate terms without a payout target.
          throw fail("PAYEE_NOT_READY");
        }
        sourcePayoutTermsId = provisioned.id;
      }
      entityLogContext = { orgId };
      readDefaultPointer = async () =>
        (await tx.organizations.getById(orgId))?.defaultPrimaryPayoutTermsId ??
        null;
      repointDefault = async (newId) => {
        await tx.organizations.update({
          id: orgId,
          defaultPrimaryPayoutTermsId: newId,
        });
      };
    } else {
      const humanId = input.entity.humanId;
      // PAYOUT ROUTING: owner-only (owner ruling 2026-09-28). A human's
      // delegates never change the schedule their principal is paid on.
      if (humanId !== input.actorHumanId) {
        throw fail("NOT_RESOURCE_OWNER");
      }

      const human = await tx.humans.getById(humanId);
      if (!human) {
        throw fail("HUMAN_NOT_FOUND");
      }
      if (human.defaultPrimaryPayoutTermsId) {
        sourcePayoutTermsId = human.defaultPrimaryPayoutTermsId;
      } else {
        // Same on-demand provisioning as the org branch (see above).
        const provisioned = await ensureEntityDefaultPrimaryTerms(
          tx,
          { type: "HUMAN", id: humanId },
          now,
          deps.logger,
          { payoutSchedule: input.payoutSchedule },
        );
        if (!provisioned) {
          throw fail("PAYEE_NOT_READY");
        }
        sourcePayoutTermsId = provisioned.id;
      }
      entityLogContext = { humanId };
      readDefaultPointer = async () =>
        (await tx.humans.getById(humanId))?.defaultPrimaryPayoutTermsId ?? null;
      repointDefault = async (newId) => {
        await tx.humans.update(humanId, {
          defaultPrimaryPayoutTermsId: newId,
        });
      };
    }

    // The terms row lock, BEFORE the clone reads the source's lines. A deal
    // write on the default (`setTermsDeal`, ORG_DEFAULT) holds the same lock
    // while it replaces the lines; without it, this clone could copy the old
    // lines and re-point the entity at that stale copy, silently dropping the
    // saved deal. Under the lock, the pointer must still name the source:
    // a concurrent schedule change may have re-pointed it already.
    if (!(await tx.deals.lockTerms(sourcePayoutTermsId))) {
      throw fail("PAYOUT_TERMS_NOT_FOUND");
    }
    if ((await readDefaultPointer()) !== sourcePayoutTermsId) {
      throw fail("CONFLICT", { meta: { reason: "default_terms_changed" } });
    }

    const existing = await tx.payoutTerms.getById(sourcePayoutTermsId);
    if (!existing) {
      throw fail("PAYOUT_TERMS_NOT_FOUND");
    }

    // Fast path: schedule already matches, nothing to do.
    if (existing.payoutSchedule === input.payoutSchedule) {
      return {
        payoutTermsId: existing.id,
        payoutSchedule: existing.payoutSchedule,
      };
    }

    // Copy-on-write: clone with the new schedule. Reset payee confirmations
    // because payout timing is a material economic term — confirmed payees
    // need to re-acknowledge under the new schedule. Bump version so the
    // chain of replacements is auditable.
    const cloned = await tx.payoutTerms.clone({
      sourcePayoutTermsId,
      payoutScheduleOverride: input.payoutSchedule,
      isDefault: true,
      resetConfirmations: true,
      bumpVersion: true,
      // Default-to-default copy: the new default never carries ABSORB.
      resetFeeMode: true,
    });
    if (!cloned) {
      throw fail("PAYOUT_TERMS_NOT_FOUND");
    }

    // Retire the source row so reverse lookups (e.g. filtering by
    // `isDefault: true`) don't see two defaults for the same entity.
    await tx.payoutTerms.markNotDefault(sourcePayoutTermsId);

    await repointDefault(cloned.id);

    deps.logger?.info("payout_schedule_updated", {
      ...entityLogContext,
      previousPayoutTermsId: sourcePayoutTermsId,
      newPayoutTermsId: cloned.id,
      oldSchedule: existing.payoutSchedule,
      newSchedule: input.payoutSchedule,
      actorHumanId: input.actorHumanId,
    });

    return {
      payoutTermsId: cloned.id,
      payoutSchedule: cloned.payoutSchedule,
    };
  });
}
