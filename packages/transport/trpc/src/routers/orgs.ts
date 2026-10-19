import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  acceptChargebackTerms,
  acceptChargebackTermsOutputSchema,
} from "@th/core/use-cases/payments";
import {
  createOrg,
  createOrgInputSchema,
  createOrgOutputSchema,
} from "@th/core/use-cases/orgs";
import {
  listOrgMembers,
  listOrgMembersInputSchema,
  listOrgMembersOutputSchema,
} from "@th/core/use-cases/orgs/list-org-members";
import {
  updateMemberRole,
  updateMemberRoleInputSchema,
  updateMemberRoleOutputSchema,
} from "@th/core/use-cases/orgs/update-member-role";
import {
  transferOrgOwnership,
  transferOrgOwnershipInputSchema,
  transferOrgOwnershipOutputSchema,
} from "@th/core/use-cases/orgs/transfer-ownership";
import {
  removeOrgMember,
  removeOrgMemberInputSchema,
  removeOrgMemberOutputSchema,
} from "@th/core/use-cases/orgs/remove-org-member";
import {
  inviteMember,
  inviteMemberInputSchema,
  inviteMemberOutputSchema,
} from "@th/core/use-cases/orgs/invite-member";
import {
  acceptInvitation,
  acceptInvitationInputSchema,
  acceptInvitationOutputSchema,
} from "@th/core/use-cases/orgs/accept-invitation";
import {
  previewInvitation,
  previewInvitationInputSchema,
  previewInvitationOutputSchema,
} from "@th/core/use-cases/orgs/preview-invitation";
import {
  revokeInvitation,
  revokeInvitationInputSchema,
  revokeInvitationOutputSchema,
} from "@th/core/use-cases/orgs/revoke-invitation";
import {
  listInvitations,
  listInvitationsInputSchema,
  listInvitationsOutputSchema,
} from "@th/core/use-cases/orgs/list-invitations";
import {
  getOrg,
  getOrgInputSchema,
  getOrgOutputSchema,
} from "@th/core/use-cases/orgs/get-org";
import {
  getOrgStats,
  getOrgStatsInputSchema,
  getOrgStatsOutputSchema,
} from "@th/core/use-cases/orgs/get-org-stats";
import {
  updateOrg,
  updateOrgInputSchema,
  updateOrgInputSchemaBase,
  updateOrgOutputSchema,
} from "@th/core/use-cases/orgs/update-org";
import {
  deleteOrg,
  deleteOrgInputSchema,
  deleteOrgOutputSchema,
} from "@th/core/use-cases/orgs/delete-org";
import {
  setDefaultAgreement,
  setDefaultAgreementInputSchema,
  setDefaultAgreementOutputSchema,
} from "@th/core/use-cases/orgs/set-default-agreement";
import {
  getOrganizationResalePolicy,
  getOrganizationResalePolicyInputSchema,
  getOrganizationResalePolicyOutputSchema,
} from "@th/core/use-cases/orgs/get-organization-resale-policy";

import { authedProcedure, rateLimit } from "../init";
import { toTrpcError } from "../utils";

const createOrgInput = createOrgInputSchema.omit({ actorHumanId: true });
const listOrgMembersInput = listOrgMembersInputSchema.omit({
  actorHumanId: true,
});
const updateMemberRoleInput = updateMemberRoleInputSchema.omit({
  actorHumanId: true,
});
const transferOrgOwnershipInput = transferOrgOwnershipInputSchema.omit({
  actorHumanId: true,
});
const removeOrgMemberInput = removeOrgMemberInputSchema.omit({
  actorHumanId: true,
});
const inviteMemberInput = inviteMemberInputSchema.omit({ actorHumanId: true });
const previewInvitationInput = previewInvitationInputSchema.omit({
  actorHumanId: true,
});
const acceptInvitationInput = acceptInvitationInputSchema.omit({
  actorHumanId: true,
});
const revokeInvitationInput = revokeInvitationInputSchema.omit({
  actorHumanId: true,
});
const listInvitationsInput = listInvitationsInputSchema.omit({
  actorHumanId: true,
});
const getOrgInput = getOrgInputSchema.omit({ actorHumanId: true });
const getOrgStatsInput = getOrgStatsInputSchema.omit({ actorHumanId: true });
const updateOrgInput = updateOrgInputSchemaBase.omit({ actorHumanId: true });
const deleteOrgInput = deleteOrgInputSchema.omit({ actorHumanId: true });
const setDefaultAgreementInput = setDefaultAgreementInputSchema.omit({
  actorHumanId: true,
});
const getOrganizationResalePolicyInput =
  getOrganizationResalePolicyInputSchema.omit({ actorHumanId: true });
const acceptOrgChargebackTermsInput = z.object({ orgId: z.uuid() }).strict();

function setDefaultAgreementProcedure() {
  return authedProcedure
    .input(setDefaultAgreementInput)
    .output(setDefaultAgreementOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof setDefaultAgreement>[0];

      try {
        return await setDefaultAgreement(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    });
}

export const orgsRouter = {
  createOrg: authedProcedure
    .input(createOrgInput)
    .output(createOrgOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
        search: ctx.multiSearch ?? undefined,
      } satisfies Parameters<typeof createOrg>[0];

      try {
        return await createOrg(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  listMembers: authedProcedure
    .input(listOrgMembersInput)
    .output(listOrgMembersOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof listOrgMembers>[0];

      try {
        return await listOrgMembers(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  updateMemberRole: authedProcedure
    .input(updateMemberRoleInput)
    .output(updateMemberRoleOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof updateMemberRole>[0];

      try {
        return await updateMemberRole(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  /**
   * The target becomes OWNER and the caller becomes ADMIN, in one
   * transaction. Only an OWNER may call it.
   */
  transferOwnership: authedProcedure
    .input(transferOrgOwnershipInput)
    .output(transferOrgOwnershipOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof transferOrgOwnership>[0];

      try {
        return await transferOrgOwnership(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  removeMember: authedProcedure
    .input(removeOrgMemberInput)
    .output(removeOrgMemberOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof removeOrgMember>[0];

      try {
        return await removeOrgMember(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  // Per-ACTOR cap (security review F8): each call mails an arbitrary
  // address. Keyed on the actor only, so it may run before `.input()`. The
  // per-ORG daily cap is enforced inside the use case, AFTER the role check,
  // so an outsider can't drain a victim org's budget by passing its orgId.
  inviteMember: authedProcedure
    .use(
      rateLimit({
        key: (ctx) => `orgs:invite:actor:${ctx.actorHumanId}`,
        maxRequests: 20,
        windowSeconds: 3600,
        message: "sending team invitations",
      }),
    )
    .input(inviteMemberInput)
    .output(inviteMemberOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
        mailer: ctx.mailer ?? undefined,
        publicAppUrl: ctx.publicAppUrl ?? undefined,
        scannerAppIosUrl: ctx.scannerAppIosUrl ?? null,
        scannerAppAndroidUrl: ctx.scannerAppAndroidUrl ?? null,
        rateLimit: ctx.rateLimit,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof inviteMember>[0];

      try {
        return await inviteMember(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  acceptInvitation: authedProcedure
    .input(acceptInvitationInput)
    .output(acceptInvitationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof acceptInvitation>[0];

      try {
        return await acceptInvitation(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  /**
   * Read-only: org name + role for the accept screen. Answers only the
   * account the invitation was sent to (same checks as acceptInvitation).
   */
  // A MUTATION although it writes nothing: tRPC queries travel as GET with
  // the input in the URL, which would put the bearer invite token into API
  // access logs and browser/Sentry fetch breadcrumbs. POST keeps it in the body.
  previewInvitation: authedProcedure
    .use(
      rateLimit({
        key: (ctx) => `orgs:previewInvitation:${ctx.actorHumanId}`,
        maxRequests: 30,
        windowSeconds: 60,
        message: "checking invitations",
      }),
    )
    .input(previewInvitationInput)
    .output(previewInvitationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof previewInvitation>[0];

      try {
        return await previewInvitation(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  revokeInvitation: authedProcedure
    .input(revokeInvitationInput)
    .output(revokeInvitationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof revokeInvitation>[0];

      try {
        return await revokeInvitation(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  listInvitations: authedProcedure
    .input(listInvitationsInput)
    .output(listInvitationsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof listInvitations>[0];

      try {
        return await listInvitations(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  getOrg: authedProcedure
    .input(getOrgInput)
    .output(getOrgOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof getOrg>[0];

      try {
        return await getOrg(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  getStats: authedProcedure
    .input(getOrgStatsInput)
    .output(getOrgStatsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof getOrgStats>[0];

      try {
        return await getOrgStats(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  updateOrg: authedProcedure
    .input(updateOrgInput)
    .output(updateOrgOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof updateOrg>[0];

      try {
        return await updateOrg(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  acceptChargebackTerms: authedProcedure
    .input(acceptOrgChargebackTermsInput)
    .output(acceptChargebackTermsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof acceptChargebackTerms>[0];

      try {
        return await acceptChargebackTerms(deps, {
          actorHumanId,
          target: { type: "ORGANIZATION", orgId: input.orgId },
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  deleteOrg: authedProcedure
    .input(deleteOrgInput)
    .output(deleteOrgOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof deleteOrg>[0];

      try {
        return await deleteOrg(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** The org's Default agreement, resale side (organiser-resale-share FR-012). */
  setDefaultAgreement: setDefaultAgreementProcedure(),

  /**
   * DEPRECATED: the old name of `setDefaultAgreement`, kept while the web
   * settings page calls it. Remove with C2 (default-agreement page).
   */
  setOrganizationResalePolicy: setDefaultAgreementProcedure(),

  getOrganizationResalePolicy: authedProcedure
    .input(getOrganizationResalePolicyInput)
    .output(getOrganizationResalePolicyOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof getOrganizationResalePolicy>[0];

      try {
        return await getOrganizationResalePolicy(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type OrgsRouter = typeof orgsRouter;
