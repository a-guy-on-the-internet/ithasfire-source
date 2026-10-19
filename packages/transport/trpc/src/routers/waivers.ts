import {
  createWaiverTemplate,
  createWaiverTemplateInputBaseSchema,
  createWaiverTemplateOutputSchema,
  updateWaiverTemplate,
  updateWaiverTemplateInputBaseSchema,
  updateWaiverTemplateOutputSchema,
  listWaiverTemplates,
  listWaiverTemplatesInputBaseSchema,
  listWaiverTemplatesOutputSchema,
  assignWaiverToEvent,
  assignWaiverToEventInputBaseSchema,
  assignWaiverToEventOutputSchema,
  getEventWaiver,
  getEventWaiverInputSchema,
  getEventWaiverOutputSchema,
} from "@th/core/use-cases/waivers";

import { ensureFullEventReadAccessByEventId } from "../event-read-access";
import { authedProcedure, optionalProcedure } from "../init";
import { toTrpcError } from "../utils";

// ─────────────────────────────────────────────────────────────────────────────
// Input schemas (strip actorHumanId — injected from context)
// ─────────────────────────────────────────────────────────────────────────────

const createInput = createWaiverTemplateInputBaseSchema.omit({
  actorHumanId: true,
});
const updateInput = updateWaiverTemplateInputBaseSchema.omit({
  actorHumanId: true,
});
const listInput = listWaiverTemplatesInputBaseSchema.omit({
  actorHumanId: true,
});
const assignInput = assignWaiverToEventInputBaseSchema.omit({
  actorHumanId: true,
});

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

export const waiversRouter = {
  /** Create a new waiver template for an org. Authed (OWNER/ADMIN). */
  createTemplate: authedProcedure
    .input(createInput)
    .output(createWaiverTemplateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createWaiverTemplate(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { actorHumanId: ctx.actorHumanId, ...input },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Update an existing waiver template. Authed (OWNER/ADMIN). */
  updateTemplate: authedProcedure
    .input(updateInput)
    .output(updateWaiverTemplateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await updateWaiverTemplate(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { actorHumanId: ctx.actorHumanId, ...input },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** List waiver templates for an org (includes platform defaults). Authed (OWNER/ADMIN/EDITOR). */
  listTemplates: authedProcedure
    .input(listInput)
    .output(listWaiverTemplatesOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await listWaiverTemplates(
          { repos: ctx.repos, logger: ctx.logger },
          { actorHumanId: ctx.actorHumanId, ...input },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Assign (or remove) a waiver template on an event. Authed (OWNER/ADMIN/EDITOR). */
  assignToEvent: authedProcedure
    .input(assignInput)
    .output(assignWaiverToEventOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await assignWaiverToEvent(
          { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
          { actorHumanId: ctx.actorHumanId, ...input },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Get the waiver for an event. No sign-in needed, but the waiver is part of
   * the event page, so a PASSWORD / APPLICATION event's waiver goes only to a
   * viewer past its gate: the same full-read gate as `listEventTicketTypes`
   * and `getCheckoutFeeRates`. `optionalProcedure`, not `publicProcedure`, so
   * a signed-in buyer's durable unlock and an organiser's bypass count (a
   * public procedure never resolves the session). An embed carries no grant
   * cookie and no session, so it reads only ungated events' waivers.
   */
  getEventWaiver: optionalProcedure
    .input(getEventWaiverInputSchema)
    .output(getEventWaiverOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        await ensureFullEventReadAccessByEventId(ctx, input.eventId);
        return await getEventWaiver(
          { repos: ctx.repos, logger: ctx.logger },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
