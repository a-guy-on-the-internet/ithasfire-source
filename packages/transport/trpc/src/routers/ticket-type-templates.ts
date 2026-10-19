import { TRPCError } from "@trpc/server";
import { createTicketTypeTemplate } from "@th/core/use-cases/ticket-type-templates/create-ticket-type-template";
import { listTicketTypeTemplates } from "@th/core/use-cases/ticket-type-templates/list-ticket-type-templates";
import { archiveTicketTypeTemplate } from "@th/core/use-cases/ticket-type-templates/archive-ticket-type-template";
import { applyTicketTypeTemplate } from "@th/core/use-cases/ticket-type-templates/apply-ticket-type-template";
import { forkPlatformTicketTemplate } from "@th/core/use-cases/ticket-type-templates/fork-platform-ticket-template";
import {
  createTicketTypeTemplateInputSchema,
  createTicketTypeTemplateResultSchema,
  listTicketTypeTemplatesInputSchema,
  listTicketTypeTemplatesResultSchema,
  archiveTicketTypeTemplateInputSchema,
  archiveTicketTypeTemplateResultSchema,
  applyTicketTypeTemplateInputSchema,
  applyTicketTypeTemplateResultSchema,
  forkPlatformTicketTemplateInputSchema,
  forkPlatformTicketTemplateResultSchema,
} from "@th/core/use-cases/ticket-type-templates/schemas";
import { getFeatureGates } from "@th/core/use-cases/features";

import { authedProcedure } from "../init";
import type { Ctx } from "../context";
import { toTrpcError } from "../utils";

const createTicketTypeTemplateInput = createTicketTypeTemplateInputSchema.omit({
  actorHumanId: true,
});
const listTicketTypeTemplatesInput = listTicketTypeTemplatesInputSchema.omit({
  actorHumanId: true,
});
const archiveTicketTypeTemplateInput =
  archiveTicketTypeTemplateInputSchema.omit({ actorHumanId: true });
const applyTicketTypeTemplateInput = applyTicketTypeTemplateInputSchema.omit({
  actorHumanId: true,
});
const forkPlatformTicketTemplateInput =
  forkPlatformTicketTemplateInputSchema.omit({ actorHumanId: true });

/** Same gate resolution as the ticket-types router (fail-closed). */
async function isResaleEnabled(ctx: Ctx): Promise<boolean> {
  const gates = await getFeatureGates({
    enableResale: ctx.enableResale,
    platformSettings: ctx.repos.platformSettings,
    reportError: ctx.reportError ?? undefined,
  });
  return gates.resale;
}

export const ticketTypeTemplatesRouter = {
  createTicketTypeTemplate: authedProcedure
    .input(createTicketTypeTemplateInput)
    .output(createTicketTypeTemplateResultSchema)
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
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof createTicketTypeTemplate>[0];

      // Gate-off clamp (create): resale can never be configured on a new
      // template while the `resale` gate is off — mirrors the upsertTicketType
      // CREATE clamp in routers/ticket-types.ts.
      const effectiveInput = (await isResaleEnabled(ctx))
        ? input
        : {
            ...input,
            ticketTypes: input.ticketTypes.map((entry) => ({
              ...entry,
              resaleAllowed: false,
              resaleCapCents: null,
            })),
          };

      try {
        return await createTicketTypeTemplate(deps, {
          ...effectiveInput,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  listTicketTypeTemplates: authedProcedure
    .input(listTicketTypeTemplatesInput)
    .output(listTicketTypeTemplatesResultSchema)
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
      } satisfies Parameters<typeof listTicketTypeTemplates>[0];

      try {
        return await listTicketTypeTemplates(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  archiveTicketTypeTemplate: authedProcedure
    .input(archiveTicketTypeTemplateInput)
    .output(archiveTicketTypeTemplateResultSchema)
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
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof archiveTicketTypeTemplate>[0];

      try {
        return await archiveTicketTypeTemplate(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  applyTicketTypeTemplate: authedProcedure
    .input(applyTicketTypeTemplateInput)
    .output(applyTicketTypeTemplateResultSchema)
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
        clock: ctx.clock,
        // Gate-off clamp (apply): a template saved while the resale gate was
        // ON must not create resale-enabled ticket types while it is OFF —
        // the use case clamps stored entries when this is false.
        resaleEnabled: await isResaleEnabled(ctx),
        logger: ctx.logger,
        // Forwarded to upsertTicketType's fee-policy scope walk.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof applyTicketTypeTemplate>[0];

      try {
        return await applyTicketTypeTemplate(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  /**
   * "Customise" — fork a LIVE platform catalogue template into an owned
   * copy (ticket-type-packs spec FR-009/FR-010). Owner-scoped; authz runs
   * inside the use case BEFORE its idempotency store is touched.
   */
  forkPlatformTemplate: authedProcedure
    .input(forkPlatformTicketTemplateInput)
    .output(forkPlatformTicketTemplateResultSchema)
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
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof forkPlatformTicketTemplate>[0];

      try {
        return await forkPlatformTicketTemplate(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type TicketTypeTemplatesRouter = typeof ticketTypeTemplatesRouter;
