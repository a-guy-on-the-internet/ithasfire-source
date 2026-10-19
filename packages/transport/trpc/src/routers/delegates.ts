import { TRPCError } from "@trpc/server";
import {
  listHumanDelegates,
  listHumanDelegatesInputSchema,
  listHumanDelegatesOutputSchema,
} from "@th/core/use-cases/delegates/list-human-delegates";
import {
  createDelegateInvite,
  createDelegateInviteInputSchema,
  createDelegateInviteOutputSchema,
} from "@th/core/use-cases/delegates/create-delegate-invite";
import {
  acceptDelegateInvite,
  acceptDelegateInviteInputSchema,
  acceptDelegateInviteOutputSchema,
} from "@th/core/use-cases/delegates/accept-delegate-invite";
import {
  previewDelegateInvite,
  previewDelegateInviteInputSchema,
  previewDelegateInviteOutputSchema,
} from "@th/core/use-cases/delegates/preview-delegate-invite";
import {
  removeHumanDelegate,
  removeHumanDelegateInputSchema,
  removeHumanDelegateOutputSchema,
} from "@th/core/use-cases/delegates/remove-human-delegate";
import {
  updateHumanDelegateRole,
  updateHumanDelegateRoleInputSchema,
  updateHumanDelegateRoleOutputSchema,
} from "@th/core/use-cases/delegates/update-human-delegate-role";

import { authedProcedure, rateLimit } from "../init";
import { toTrpcError } from "../utils";

const listInput = listHumanDelegatesInputSchema.omit({ actorHumanId: true });
const createInviteInput = createDelegateInviteInputSchema.omit({
  actorHumanId: true,
});
const previewInviteInput = previewDelegateInviteInputSchema.omit({
  actorHumanId: true,
});
const acceptInviteInput = acceptDelegateInviteInputSchema.omit({
  actorHumanId: true,
});
const removeInput = removeHumanDelegateInputSchema.omit({ actorHumanId: true });
const updateRoleInput = updateHumanDelegateRoleInputSchema.omit({
  actorHumanId: true,
});

export const delegatesRouter = {
  listDelegates: authedProcedure
    .input(listInput)
    .output(listHumanDelegatesOutputSchema)
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
      } satisfies Parameters<typeof listHumanDelegates>[0];

      try {
        return await listHumanDelegates(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Mint a delegate invitation link (replaces `addDelegate`, which granted a
   * delegation to any humanId without consent — security review F3). Writes
   * no grant; the invited person must accept via `acceptInvite`. Sends no
   * email, so it is not a relay; capped per actor anyway.
   */
  createInvite: authedProcedure
    .use(
      rateLimit({
        key: (ctx) => `delegates:createInvite:${ctx.actorHumanId}`,
        maxRequests: 20,
        windowSeconds: 3600,
        message: "creating delegate invitations",
      }),
    )
    .input(createInviteInput)
    .output(createDelegateInviteOutputSchema)
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
        inviteSecret: ctx.delegateInviteSecret ?? null,
      } satisfies Parameters<typeof createDelegateInvite>[0];

      try {
        return await createDelegateInvite(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Read-only: who is inviting and for which role, for the accept screen.
   * Answers only the account the link was made for; claims nothing.
   */
  // A MUTATION although it writes nothing: tRPC queries travel as GET with
  // the input in the URL, which would put the bearer invite token into API
  // access logs and browser/Sentry fetch breadcrumbs. POST keeps it in the body.
  previewInvite: authedProcedure
    .use(
      rateLimit({
        key: (ctx) => `delegates:previewInvite:${ctx.actorHumanId}`,
        maxRequests: 30,
        windowSeconds: 60,
        message: "checking delegate invitations",
      }),
    )
    .input(previewInviteInput)
    .output(previewDelegateInviteOutputSchema)
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
        idempotency: ctx.idempotency,
        inviteSecret: ctx.delegateInviteSecret ?? null,
      } satisfies Parameters<typeof previewDelegateInvite>[0];

      try {
        return await previewDelegateInvite(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** The invited person accepts; the grant is created with THEM as delegate. */
  acceptInvite: authedProcedure
    .use(
      rateLimit({
        key: (ctx) => `delegates:acceptInvite:${ctx.actorHumanId}`,
        maxRequests: 10,
        windowSeconds: 60,
        message: "accepting delegate invitations",
      }),
    )
    .input(acceptInviteInput)
    .output(acceptDelegateInviteOutputSchema)
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
        idempotency: ctx.idempotency,
        logger: ctx.logger,
        inviteSecret: ctx.delegateInviteSecret ?? null,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof acceptDelegateInvite>[0];

      try {
        return await acceptDelegateInvite(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  removeDelegate: authedProcedure
    .input(removeInput)
    .output(removeHumanDelegateOutputSchema)
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
        authn: ctx.authn,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof removeHumanDelegate>[0];

      try {
        return await removeHumanDelegate(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  updateDelegateRole: authedProcedure
    .input(updateRoleInput)
    .output(updateHumanDelegateRoleOutputSchema)
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
        authn: ctx.authn,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof updateHumanDelegateRole>[0];

      try {
        return await updateHumanDelegateRole(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type DelegatesRouter = typeof delegatesRouter;
