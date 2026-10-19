import { z } from "zod";

import { fail } from "@th/errors";
import type { MembershipBillingPort } from "@th/ports/membership-billing-port";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import {
  archiveMembershipTier,
  archiveMembershipTierInputSchema,
  archiveMembershipTierOutputSchema,
  attachTierBenefit,
  attachTierBenefitInputSchema,
  attachTierBenefitOutputSchema,
  cancelMembership,
  cancelMembershipInputSchema,
  createMembershipPortalSession,
  createMembershipPortalSessionOutputSchema,
  createMembershipTier,
  createMembershipTierInputSchemaBase,
  listMemberBlocks,
  listMemberBlocksInputSchema,
  listMemberBlocksOutputSchema,
  listMyMemberships,
  listMyMembershipsOutputSchema,
  listPublicTiers,
  listPublicTiersInputSchema,
  listPublicTiersOutputSchema,
  listTiersForOwner,
  listTiersForOwnerInputSchema,
  listTiersForOwnerOutputSchema,
  membershipOutputSchema,
  membershipTierOutputSchema,
  publishMembershipTier,
  publishMembershipTierInputSchema,
  removeTierBenefit,
  removeTierBenefitInputSchema,
  removeTierBenefitOutputSchema,
  startMembership,
  startMembershipInputSchema,
  startMembershipOutputSchema,
  updateMembershipTier,
  updateMembershipTierInputSchema,
  updateMembershipTierOutputSchema,
  updateTierBenefit,
  updateTierBenefitInputSchema,
  updateTierBenefitOutputSchema,
} from "@th/core/use-cases/memberships";

import type { Ctx } from "../context";
import { authedProcedure, publicProcedure, router } from "../init";
import { toTrpcError } from "../utils";

// ─────────────────────────────────────────────────────────────────────────────
// Memberships router.
//
// Thin by construction: every procedure parses input, injects the
// authenticated actor, and calls a core use case — authz (owner roles,
// member-owns-membership) lives in core, matching the promos/orders idiom.
// `actorHumanId` is ALWAYS injected from ctx, never accepted from the client.
// ─────────────────────────────────────────────────────────────────────────────

// actorHumanId stripped at the boundary and injected from ctx.
const createTierInput = createMembershipTierInputSchemaBase.omit({
  actorHumanId: true,
});
const updateTierInput = updateMembershipTierInputSchema.omit({
  actorHumanId: true,
});
const archiveTierInput = archiveMembershipTierInputSchema.omit({
  actorHumanId: true,
});
const publishTierInput = publishMembershipTierInputSchema.omit({
  actorHumanId: true,
});
const listTiersInput = listTiersForOwnerInputSchema.omit({
  actorHumanId: true,
});
const attachBenefitInput = attachTierBenefitInputSchema.omit({
  actorHumanId: true,
});
const updateBenefitInput = updateTierBenefitInputSchema.omit({
  actorHumanId: true,
});
const removeBenefitInput = removeTierBenefitInputSchema.omit({
  actorHumanId: true,
});
const cancelInput = cancelMembershipInputSchema.omit({ actorHumanId: true });
const memberBlocksInput = listMemberBlocksInputSchema.omit({
  actorHumanId: true,
});
// The member is the caller; their billing address is the only client input.
const startInput = startMembershipInputSchema.omit({
  memberHumanId: true,
  memberEmail: true,
  memberName: true,
});

const portalSessionInput = z
  .object({
    membershipId: z.string().uuid(),
    /**
     * Same-site path Stripe returns the member to. Path-only by schema (must
     * start with "/", never "//") so the portal can never be aimed off-site.
     */
    returnPath: z
      .string()
      .max(500)
      .regex(/^\/(?!\/)/, "returnPath must be a same-site path")
      .default("/account/memberships"),
  })
  .strict();

function requireBilling(ctx: Ctx): MembershipBillingPort {
  if (!ctx.membershipBilling) {
    throw toTrpcError(
      fail("NOT_CONFIGURED", { meta: { port: "membershipBilling" } }),
    );
  }
  return ctx.membershipBilling;
}

function requireTaxRateLookup(ctx: Ctx): TaxRateLookupPort {
  if (!ctx.taxRateLookup) {
    throw toTrpcError(
      fail("NOT_CONFIGURED", { meta: { port: "taxRateLookup" } }),
    );
  }
  return ctx.taxRateLookup;
}

function requirePublicAppUrl(ctx: Ctx): string {
  if (!ctx.publicAppUrl) {
    throw toTrpcError(
      fail("NOT_CONFIGURED", { meta: { setting: "publicAppUrl" } }),
    );
  }
  return ctx.publicAppUrl.replace(/\/+$/, "");
}

const tiersRouter = router({
  // Admin: every status + benefits + member counts. Org-role gate in core.
  list: authedProcedure
    .input(listTiersInput)
    .output(listTiersForOwnerOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await listTiersForOwner(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // Public join page: ACTIVE tiers only, display fields only.
  listPublic: publicProcedure
    .input(listPublicTiersInputSchema)
    .output(listPublicTiersOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await listPublicTiers(
          { repos: ctx.repos, logger: ctx.logger },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  create: authedProcedure
    .input(createTierInput)
    .output(membershipTierOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const tier = await createMembershipTier(
          { repos: ctx.repos },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
        return membershipTierOutputSchema.parse(tier);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  update: authedProcedure
    .input(updateTierInput)
    .output(updateMembershipTierOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await updateMembershipTier(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  archive: authedProcedure
    .input(archiveTierInput)
    .output(archiveMembershipTierOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await archiveMembershipTier(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  publish: authedProcedure
    .input(publishTierInput)
    .output(membershipTierOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const tier = await publishMembershipTier(
          {
            repos: ctx.repos,
            membershipBilling: requireBilling(ctx),
            logger: ctx.logger,
          },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
        return membershipTierOutputSchema.parse(tier);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
});

const benefitsRouter = router({
  attach: authedProcedure
    .input(attachBenefitInput)
    .output(attachTierBenefitOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await attachTierBenefit(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  update: authedProcedure
    .input(updateBenefitInput)
    .output(updateTierBenefitOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await updateTierBenefit(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  remove: authedProcedure
    .input(removeBenefitInput)
    .output(removeTierBenefitOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await removeTierBenefit(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
});

const mineRouter = router({
  list: authedProcedure
    .output(listMyMembershipsOutputSchema)
    .query(async ({ ctx }) => {
      try {
        return await listMyMemberships(
          { repos: ctx.repos, logger: ctx.logger },
          { actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
});

export const membershipsRouter = {
  tiers: tiersRouter,
  benefits: benefitsRouter,
  mine: mineRouter,

  // Member-gated `section == "memberships"` page blocks. Authed BY DESIGN and
  // never part of the public page payload — `getPublicPage` drops non-main
  // sections unconditionally (they would otherwise land in anonymously-cached
  // HTML/RSC flight). The membership check itself lives in core
  // (listMemberBlocks); a non-member simply receives an empty list.
  memberBlocks: authedProcedure
    .input(memberBlocksInput)
    .output(listMemberBlocksOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await listMemberBlocks(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // Output carries `paymentIntentClientSecret` — the Elements confirmation
  // hand-off for the caller's own new subscription (null when there is
  // nothing to pay). It is a bearer credential: NEVER log it.
  start: authedProcedure
    .input(startInput)
    .output(startMembershipOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const membershipBilling = requireBilling(ctx);
        const taxRateLookup = requireTaxRateLookup(ctx);
        // The member's saved identity feeds the Stripe Customer — never
        // client-supplied, so a caller cannot plant someone else's email on
        // the billing object.
        const identity = ctx.actorHumanId
          ? await ctx.repos.humans.getByIdWithIdentity(ctx.actorHumanId)
          : null;
        const membership = await startMembership(
          {
            repos: ctx.repos,
            membershipBilling,
            taxRateLookup,
            clock: ctx.clock,
            logger: ctx.logger,
            ...(ctx.reportError ? { reportError: ctx.reportError } : {}),
          },
          {
            ...input,
            memberHumanId: ctx.actorHumanId,
            memberEmail: identity?.identity.email ?? null,
            memberName: identity?.human.name ?? null,
          },
        );
        return startMembershipOutputSchema.parse(membership);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  cancel: authedProcedure
    .input(cancelInput)
    .output(membershipOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const membership = await cancelMembership(
          {
            repos: ctx.repos,
            membershipBilling: requireBilling(ctx),
            logger: ctx.logger,
          },
          { ...input, actorHumanId: ctx.actorHumanId },
        );
        return membershipOutputSchema.parse(membership);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  portalSession: authedProcedure
    .input(portalSessionInput)
    .output(createMembershipPortalSessionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const returnUrl = `${requirePublicAppUrl(ctx)}${input.returnPath}`;
        return await createMembershipPortalSession(
          {
            repos: ctx.repos,
            membershipBilling: requireBilling(ctx),
            logger: ctx.logger,
          },
          {
            actorHumanId: ctx.actorHumanId,
            membershipId: input.membershipId,
            returnUrl,
          },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type MembershipsRouter = typeof membershipsRouter;
