import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import {
  dealNotEditableReasonSchema,
  dealTargetSchema,
  loadTermsDealContext,
  type TermsDealContextRepos,
} from "./_shared/deal-target";
import { dealFingerprint } from "./_shared/deal-fingerprint";
import { describeDealForViewer, getAgreementDealOutputSchema } from "./get-agreement-deal";
import {
  projectAgreementDealInputSchema,
  projectDealForViewer,
  projectedDealOutputShapes,
} from "./project-agreement-deal";
import { loadResaleTermsView, resaleTermsViewSchema } from "./_shared/resale-terms-view";
import { loadDealFreezeView } from "./_shared/deal-freeze-view";

// ─────────────────────────────────────────────────────────────────────────────
// getTermsDeal — the deal on any target, shaped for the viewer
// ─────────────────────────────────────────────────────────────────────────────

export const getTermsDealInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    target: dealTargetSchema,
  })
  .strict();

export const getTermsDealOutputSchema = getAgreementDealOutputSchema
  .omit({ agreementId: true })
  .extend({
    target: dealTargetSchema,
    /** The booking agreement, for a BOOKING_AGREEMENT target; else null. */
    agreementId: z.uuid().nullable(),
    /** Why `mayEdit` is false (null when it is true), for the editor to say. */
    notEditableReason: dealNotEditableReasonSchema.nullable(),
    /**
     * The stored deal's fingerprint. `setTermsDeal` requires it back as
     * `expectedDealFingerprint` and refuses a save over a deal changed since.
     */
    dealFingerprint: z.string(),
    /**
     * The resale clause (organiser-resale-share FR-011) on the target's
     * RESALE terms: the event's (EVENT, or the booking's event) or the org's
     * default. Written by `setResaleClause`.
     */
    resaleTerms: resaleTermsViewSchema,
  })
  .strict();

export type GetTermsDealInput = z.infer<typeof getTermsDealInputSchema>;
export type GetTermsDealOutput = z.infer<typeof getTermsDealOutputSchema>;

export type GetTermsDealDeps = {
  repos: TermsDealContextRepos & Pick<Repos, "humans">;
};

/**
 * Read back what `setTermsDeal` wrote, for any target (see
 * `_shared/deal-target.ts` for who sees what and who may edit). A
 * BOOKING_AGREEMENT target answers exactly as `getAgreementDeal`.
 */
export async function getTermsDeal(
  deps: GetTermsDealDeps,
  rawInput: unknown,
): Promise<GetTermsDealOutput> {
  const input = parseInput(getTermsDealInputSchema, rawInput);
  const ctx = await loadTermsDealContext(deps.repos, input);
  const shaped = await describeDealForViewer(deps.repos, ctx);
  const resaleTerms = await loadResaleTermsView(
    deps.repos,
    ctx.target,
    ctx.eventId,
    ctx.viewer.visibility,
  );
  // The freeze (freeze-the-deal FR-001) on the deal's event: the EVENT
  // target's, the booking's event; null for an org default.
  const dealFreeze = await loadDealFreezeView(deps.repos, ctx.eventId);
  return getTermsDealOutputSchema.parse({
    target: ctx.target,
    agreementId: ctx.agreementId,
    payoutTermsId: ctx.payoutTermsId,
    mayEdit: ctx.mayEdit,
    notEditableReason: ctx.notEditableReason,
    dealFingerprint: dealFingerprint(ctx.deal),
    resaleTerms,
    dealFreeze,
    ...shaped,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// projectTermsDeal — "if we sell N at $P", on any target
// ─────────────────────────────────────────────────────────────────────────────

export const projectTermsDealInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    target: dealTargetSchema,
    /**
     * Absent = default from the event's ticket types (EVENT target, or a
     * booking with an event). ORG_DEFAULT has no event: tiers are required.
     */
    tiers: projectAgreementDealInputSchema.shape.tiers,
  })
  .strict();

export const projectTermsDealOutputSchema = z.discriminatedUnion("needsTiers", [
  z.object({ target: dealTargetSchema, ...projectedDealOutputShapes.projected }).strict(),
  z.object({ target: dealTargetSchema, ...projectedDealOutputShapes.needsTiers }).strict(),
]);

export type ProjectTermsDealInput = z.infer<typeof projectTermsDealInputSchema>;
export type ProjectTermsDealOutput = z.infer<typeof projectTermsDealOutputSchema>;

export type ProjectTermsDealDeps = GetTermsDealDeps & { clock: ClockPort };

export async function projectTermsDeal(
  deps: ProjectTermsDealDeps,
  rawInput: unknown,
): Promise<ProjectTermsDealOutput> {
  const input = parseInput(projectTermsDealInputSchema, rawInput);
  const ctx = await loadTermsDealContext(deps.repos, input);
  const projected = await projectDealForViewer(deps, ctx, input.tiers);
  return projectTermsDealOutputSchema.parse({ target: ctx.target, ...projected });
}
