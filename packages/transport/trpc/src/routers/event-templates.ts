import { TRPCError } from "@trpc/server";
import { createEventTemplate } from "@th/core/use-cases/event-templates/create-event-template";
import { listEventTemplates } from "@th/core/use-cases/event-templates/list-event-templates";
import {
  createEventTemplateInputSchema,
  createEventTemplateResultSchema,
  listEventTemplatesInputSchema,
  listEventTemplatesResultSchema,
} from "@th/core/use-cases/event-templates/schemas";

import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

const createEventTemplateInput = createEventTemplateInputSchema.omit({
  actorHumanId: true,
});
const listEventTemplatesInput = listEventTemplatesInputSchema.omit({
  actorHumanId: true,
});

export const eventTemplatesRouter = {
  createEventTemplate: authedProcedure
    .input(createEventTemplateInput)
    .output(createEventTemplateResultSchema)
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
      } satisfies Parameters<typeof createEventTemplate>[0];

      try {
        return await createEventTemplate(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  listEventTemplates: authedProcedure
    .input(listEventTemplatesInput)
    .output(listEventTemplatesResultSchema)
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
      } satisfies Parameters<typeof listEventTemplates>[0];

      try {
        return await listEventTemplates(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type EventTemplatesRouter = typeof eventTemplatesRouter;
