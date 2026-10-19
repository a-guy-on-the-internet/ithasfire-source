import { TRPCError } from "@trpc/server";

import { listApplicationFormTemplates } from "@th/core/use-cases/application-form-templates/list-application-form-templates";
import { createApplicationFormTemplate } from "@th/core/use-cases/application-form-templates/create-application-form-template";
import { updateApplicationFormTemplate } from "@th/core/use-cases/application-form-templates/update-application-form-template";
import { archiveApplicationFormTemplate } from "@th/core/use-cases/application-form-templates/archive-application-form-template";
import { applyApplicationFormTemplate } from "@th/core/use-cases/application-form-templates/apply-application-form-template";
import { saveFormAsApplicationTemplate } from "@th/core/use-cases/application-form-templates/save-form-as-template";
import {
  listApplicationFormTemplatesInputSchema,
  listApplicationFormTemplatesResultSchema,
  createApplicationFormTemplateInputSchema,
  createApplicationFormTemplateResultSchema,
  updateApplicationFormTemplateInputSchema,
  updateApplicationFormTemplateResultSchema,
  archiveApplicationFormTemplateInputSchema,
  archiveApplicationFormTemplateResultSchema,
  applyApplicationFormTemplateInputSchema,
  applyApplicationFormTemplateResultSchema,
  saveFormAsApplicationTemplateInputSchema,
  saveFormAsApplicationTemplateResultSchema,
} from "@th/core/use-cases/application-form-templates/schemas";

import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

/**
 * Application-form templates (application-driven-events spec Phase 4).
 *
 * Deliberately its OWN router rather than more surface on `routers/events.ts`:
 * four of the six procedures are owner-scoped, not event-scoped, and the
 * template editor in the org workspace never touches an event at all.
 *
 * Thin by contract — every procedure parses input, injects the session's
 * actor, calls one use case and maps the error. All authorization
 * (owner scope AND event editability) lives in the use cases.
 */

const listInput = listApplicationFormTemplatesInputSchema.omit({
  actorHumanId: true,
});
const createInput = createApplicationFormTemplateInputSchema.omit({
  actorHumanId: true,
});
const updateInput = updateApplicationFormTemplateInputSchema.omit({
  actorHumanId: true,
});
const archiveInput = archiveApplicationFormTemplateInputSchema.omit({
  actorHumanId: true,
});
const applyInput = applyApplicationFormTemplateInputSchema.omit({
  actorHumanId: true,
});
const saveFromEventInput = saveFormAsApplicationTemplateInputSchema.omit({
  actorHumanId: true,
});

/**
 * `authedProcedure` guarantees a session but not that it carries a Human row
 * (a freshly created auth user can be mid-provisioning), so every procedure
 * re-checks — same shape as routers/ticket-type-templates.ts.
 */
function requireActor(actorHumanId: string | null | undefined): string {
  if (!actorHumanId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing actor human id",
    });
  }
  return actorHumanId;
}

export const applicationFormTemplatesRouter = {
  /** Owner library + the platform starter catalogue, archived excluded. */
  list: authedProcedure
    .input(listInput)
    .output(listApplicationFormTemplatesResultSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await listApplicationFormTemplates(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  create: authedProcedure
    .input(createInput)
    .output(createApplicationFormTemplateResultSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await createApplicationFormTemplate(
          {
            repos: ctx.repos,
            idempotency: ctx.idempotency,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  update: authedProcedure
    .input(updateInput)
    .output(updateApplicationFormTemplateResultSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await updateApplicationFormTemplate(
          {
            repos: ctx.repos,
            idempotency: ctx.idempotency,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  archive: authedProcedure
    .input(archiveInput)
    .output(archiveApplicationFormTemplateResultSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await archiveApplicationFormTemplate(
          {
            repos: ctx.repos,
            idempotency: ctx.idempotency,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Fork-on-use: seeds the event's form + question rows from a template.
   *
   * NAMED `applyToEvent`, not `apply`: tRPC rejects `apply` as a procedure
   * key (it collides with `Function.prototype.apply` on the router object)
   * and throws "Reserved words used in `router({})` call" at construction —
   * i.e. it takes the whole API down, not just this route.
   */
  applyToEvent: authedProcedure
    .input(applyInput)
    .output(applyApplicationFormTemplateResultSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await applyApplicationFormTemplate(
          {
            repos: ctx.repos,
            idempotency: ctx.idempotency,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Snapshot an event's current form up into the owner's library. */
  saveFromEvent: authedProcedure
    .input(saveFromEventInput)
    .output(saveFormAsApplicationTemplateResultSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      try {
        return await saveFormAsApplicationTemplate(
          {
            repos: ctx.repos,
            idempotency: ctx.idempotency,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type ApplicationFormTemplatesRouter =
  typeof applicationFormTemplatesRouter;
