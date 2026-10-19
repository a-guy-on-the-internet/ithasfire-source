import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_ADMIN_ROLES } from "../../lib/rbac";
import { RESALE_CLAIM_WINDOW_DAYS } from "../../lib/resale-claim-window";
import { fail } from "@th/errors";

export const setDefaultAgreementInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    orgId: z.string().uuid(),
    /**
     * Optional override of the platform-wide resale release window (days).
     * Still accepts 0–365 (the settings form and any stored value below the
     * claim window keep saving), but a value below RESALE_CLAIM_WINDOW_DAYS is
     * persisted AS the claim window: paying the seller before the buyer's
     * claim window closes is not a policy an organiser can choose.
     */
    payoutReleaseDays: z.number().int().min(0).max(365).nullable().optional(),
  })
  .strict();

export const setDefaultAgreementOutputSchema = z
  .object({
    orgId: z.string().uuid(),
    payoutTermsId: z.string().uuid(),
    payoutReleaseDays: z.number().int(),
  })
  .strict();

export type SetDefaultAgreementInput = z.infer<
  typeof setDefaultAgreementInputSchema
>;
export type SetDefaultAgreementOutput = z.infer<
  typeof setDefaultAgreementOutputSchema
>;

export type SetDefaultAgreementDeps = {
  repos: Pick<
    Repos,
    "tx" | "organizations" | "payoutTerms" | "audit" | "authz" | "deals"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * The org's Default agreement (organiser-resale-share FR-012; renamed from
 * `setOrganizationResalePolicy`, owner R19). Writes the resale side of it —
 * the seller release days — on a long-lived RESALE PayoutTerms template row referenced by
 * `Organization.defaultResalePayoutTermsId`. The resale clause on the same
 * row is written by `setResaleClause` (target ORG_DEFAULT); the ticket-sales
 * default by `setTermsDeal` (target ORG_DEFAULT). New events clone the
 * template, clause included (`clonePayoutTermsRow`).
 *
 * The template encodes only the clause + release window — lines are
 * composed per-event because they depend on which lineup / co-promoter
 * Payees are involved. New events with resale-allowed ticket types fork
 * a fresh single-use PayoutTerms from this template at creation; later
 * org-level changes here do not bleed into already-created events.
 */
export async function setDefaultAgreement(
  deps: SetDefaultAgreementDeps,
  rawInput: unknown,
): Promise<SetDefaultAgreementOutput> {
  const input = parseInput(setDefaultAgreementInputSchema, rawInput);

  await requireOrgMembership({
    repos: deps.repos,
    orgId: input.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_ADMIN_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });

  const org = await deps.repos.organizations.getById(input.orgId);
  if (!org) {
    throw fail("ORG_NOT_FOUND");
  }

  const now = deps.clock.now();

  // Floored at the claim window (see the input schema). `null`/absent keeps
  // meaning "leave as is" / "use the column default".
  const payoutReleaseDays =
    input.payoutReleaseDays != null
      ? Math.max(input.payoutReleaseDays, RESALE_CLAIM_WINDOW_DAYS)
      : null;

  const result = await deps.repos.tx(async (tx) => {
    // The pointer is read here, inside the transaction: the read above is a
    // fast-fail, and a concurrent first save may have pinned a template since.
    let termsId =
      (await tx.organizations.getById(input.orgId))?.defaultResalePayoutTermsId ??
      null;

    if (termsId) {
      // The template row's lock, as every writer of it takes
      // (`setResaleClause`); then confirm it is still the org's.
      if (!(await tx.deals.lockTerms(termsId))) throw fail("PAYOUT_TERMS_NOT_FOUND");
      const locked = await tx.organizations.getById(input.orgId);
      if ((locked?.defaultResalePayoutTermsId ?? null) !== termsId) {
        throw fail("CONFLICT", { message: "default_agreement_changed" });
      }
      // Existing template — just update the release window.
      const updated = await tx.payoutTerms.updateDraft({
        payoutTermsId: termsId,
        ...(payoutReleaseDays != null
          ? { resalePayoutReleaseDays: payoutReleaseDays }
          : {}),
      });
      return {
        payoutTermsId: termsId,
        // Effective, not raw: a template stored below the window before the
        // floor existed is clamped at use (`computeResaleSchedule`,
        // `createCreditsFromOrder`), so report what will actually apply.
        payoutReleaseDays: Math.max(
          updated.resalePayoutReleaseDays,
          RESALE_CLAIM_WINDOW_DAYS,
        ),
      };
    }

    // Mint a new template row and pin it to the org.
    const created = await tx.payoutTerms.createDraft({
      kind: "RESALE",
      settlementCurrency: "usd",
      resalePayoutReleaseDays: payoutReleaseDays ?? undefined,
    });
    termsId = created.id;

    // Guarded: links only while the org has no template. A concurrent first
    // save (this or `setResaleClause`) that linked first wins; this one
    // conflicts and its row rolls back with the transaction.
    const linked = await tx.deals.linkOrgDefaultResaleTermsIfUnset({
      orgId: input.orgId,
      payoutTermsId: termsId,
    });
    if (!linked) {
      throw fail("CONFLICT", { message: "default_agreement_changed" });
    }

    return {
      payoutTermsId: termsId,
      payoutReleaseDays: created.resalePayoutReleaseDays,
    };
  });

  await deps.repos.audit.log({
    entity: "organization",
    entityId: input.orgId,
    action: "resale_policy_updated",
    data: {
      payoutTermsId: result.payoutTermsId,
      payoutReleaseDays: result.payoutReleaseDays,
      actorHumanId: input.actorHumanId,
    },
    at: now,
  });

  deps.logger?.info("organizations.set_default_agreement", {
    orgId: input.orgId,
    actorHumanId: input.actorHumanId,
    payoutTermsId: result.payoutTermsId,
  });

  return setDefaultAgreementOutputSchema.parse({
    orgId: input.orgId,
    payoutTermsId: result.payoutTermsId,
    payoutReleaseDays: result.payoutReleaseDays,
  });
}
