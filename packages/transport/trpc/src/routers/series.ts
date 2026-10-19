import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createEventSeries } from "@th/core/use-cases/series/create-event-series";
import { updateEventSeries } from "@th/core/use-cases/series/update-event-series";
import { archiveEventSeries } from "@th/core/use-cases/series/archive-event-series";
import { cancelEventSeries } from "@th/core/use-cases/series/cancel-event-series";
import { expandSeries } from "@th/core/use-cases/series/expand-series";
import { listEventSeries } from "@th/core/use-cases/series/list-event-series";
import { listSeriesOccurrences } from "@th/core/use-cases/series/list-series-occurrences";
import { listPublicSeriesDates } from "@th/core/use-cases/series/list-public-series-dates";
import { reconcileSeriesSchedule } from "@th/core/use-cases/series/reconcile-series-schedule";
import { convertEventToSeries } from "@th/core/use-cases/series/convert-event-to-series";
import { generateEventsFromSeries } from "@th/core/use-cases/series/generate-events-from-series";
import { syncSeriesDrafts } from "@th/core/use-cases/series/sync-series-drafts";
import { skipOccurrence } from "@th/core/use-cases/series/skip-occurrence";
import { restoreOccurrence } from "@th/core/use-cases/series/restore-occurrence";
import { addSeriesOccurrence } from "@th/core/use-cases/series/add-series-occurrence";
import { listSeriesDatesForAdmin } from "@th/core/use-cases/series/list-series-dates-for-admin";
import {
  convertEventToSeriesInputSchema,
  convertEventToSeriesResultSchema,
  createEventSeriesInputSchema,
  createEventSeriesResultSchema,
  generateEventsFromSeriesInputSchemaBase,
  generateEventsFromSeriesResultSchema,
  syncSeriesDraftsInputSchema,
  syncSeriesDraftsResultSchema,
  updateEventSeriesInputSchema,
  updateEventSeriesResultSchema,
  archiveEventSeriesInputSchema,
  archiveEventSeriesResultSchema,
  cancelEventSeriesInputSchema,
  cancelEventSeriesResultSchema,
  expandSeriesInputSchema,
  expandSeriesInputSchemaBase,
  expandSeriesResultSchema,
  listSeriesInputSchema,
  listSeriesResultSchema,
  listOccurrencesInputSchema,
  listOccurrencesInputSchemaBase,
  listOccurrencesResultSchema,
  listPublicSeriesDatesInputSchema,
  listPublicSeriesDatesResultSchema,
  reconcileSeriesScheduleInputSchemaBase,
  reconcileSeriesScheduleResultSchema,
  skipOccurrenceInputSchema,
  skipOccurrenceResultSchema,
  restoreOccurrenceInputSchema,
  restoreOccurrenceResultSchema,
  addSeriesOccurrenceInputSchemaBase,
  addSeriesOccurrenceResultSchema,
  listSeriesDatesForAdminInputSchema,
  listSeriesDatesForAdminResultSchema,
} from "@th/core/use-cases/series/schemas";

import { authedProcedure, publicProcedure } from "../init";
import { toTrpcError } from "../utils";

const createEventSeriesInput = createEventSeriesInputSchema.omit({
  actorHumanId: true,
});
const updateEventSeriesInput = updateEventSeriesInputSchema.omit({
  actorHumanId: true,
});
const archiveEventSeriesInput = archiveEventSeriesInputSchema.omit({
  actorHumanId: true,
});
const expandSeriesInput = expandSeriesInputSchemaBase.omit({
  actorHumanId: true,
});
const listEventSeriesInput = listSeriesInputSchema.omit({ actorHumanId: true });
const listOccurrencesInput = listOccurrencesInputSchemaBase.omit({
  actorHumanId: true,
});
const reconcileSeriesScheduleInput =
  reconcileSeriesScheduleInputSchemaBase.omit({ actorHumanId: true });
const convertEventToSeriesInput = convertEventToSeriesInputSchema.omit({
  actorHumanId: true,
});
const generateEventsFromSeriesInput =
  generateEventsFromSeriesInputSchemaBase.omit({ actorHumanId: true });
const syncSeriesDraftsInput = syncSeriesDraftsInputSchema.omit({
  actorHumanId: true,
});
const skipOccurrenceInput = skipOccurrenceInputSchema.omit({
  actorHumanId: true,
});
const restoreOccurrenceInput = restoreOccurrenceInputSchema.omit({
  actorHumanId: true,
});
const addSeriesOccurrenceInput = addSeriesOccurrenceInputSchemaBase.omit({
  actorHumanId: true,
});
// tRPC's useInfiniteQuery injects a top-level `direction` ("forward" |
// "backward") on every request. listSeriesDatesForAdminInputSchema is
// `.strict()`, and Zod's `.omit()` PRESERVES that strictness, so without
// allowing `direction` the whole call 400s (unrecognized_keys) — breaking the
// admin Dates page list. Allow it here; the handler strips it before the use
// case (which re-validates with the strict base schema). Mirrors
// event-saves.ts / community.ts.
const listSeriesDatesForAdminInput = listSeriesDatesForAdminInputSchema
  .omit({ actorHumanId: true })
  .extend({ direction: z.enum(["forward", "backward"]).optional() });

export const seriesRouter = {
  createEventSeries: authedProcedure
    .input(createEventSeriesInput)
    .output(createEventSeriesResultSchema)
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
      } satisfies Parameters<typeof createEventSeries>[0];

      try {
        return await createEventSeries(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  updateEventSeries: authedProcedure
    .input(updateEventSeriesInput)
    .output(updateEventSeriesResultSchema)
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
      } satisfies Parameters<typeof updateEventSeries>[0];

      try {
        return await updateEventSeries(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  archiveEventSeries: authedProcedure
    .input(archiveEventSeriesInput)
    .output(archiveEventSeriesResultSchema)
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
      } satisfies Parameters<typeof archiveEventSeries>[0];

      try {
        return await archiveEventSeries(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  expandSeries: authedProcedure
    .input(expandSeriesInput)
    .output(expandSeriesResultSchema)
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
      } satisfies Parameters<typeof expandSeries>[0];

      try {
        return await expandSeries(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  listEventSeries: authedProcedure
    .input(listEventSeriesInput)
    .output(listSeriesResultSchema)
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
      } satisfies Parameters<typeof listEventSeries>[0];

      try {
        return await listEventSeries(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  listSeriesOccurrences: authedProcedure
    .input(listOccurrencesInput)
    .output(listOccurrencesResultSchema)
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
      } satisfies Parameters<typeof listSeriesOccurrences>[0];

      try {
        return await listSeriesOccurrences(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  reconcileSeriesSchedule: authedProcedure
    .input(reconcileSeriesScheduleInput)
    .output(reconcileSeriesScheduleResultSchema)
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
      } satisfies Parameters<typeof reconcileSeriesSchedule>[0];

      try {
        return await reconcileSeriesSchedule(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  convertEventToSeries: authedProcedure
    .input(convertEventToSeriesInput)
    .output(convertEventToSeriesResultSchema)
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
      } satisfies Parameters<typeof convertEventToSeries>[0];

      try {
        return await convertEventToSeries(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  generateEventsFromSeries: authedProcedure
    .input(generateEventsFromSeriesInput)
    .output(generateEventsFromSeriesResultSchema)
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
        // Reports the deliberate swallow when a generated draft cannot be
        // slugged (ReporterPort convention).
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof generateEventsFromSeries>[0];

      try {
        return await generateEventsFromSeries(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  syncSeriesDrafts: authedProcedure
    .input(syncSeriesDraftsInput)
    .output(syncSeriesDraftsResultSchema)
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
      } satisfies Parameters<typeof syncSeriesDrafts>[0];

      try {
        return await syncSeriesDrafts(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  skipOccurrence: authedProcedure
    .input(skipOccurrenceInput)
    .output(skipOccurrenceResultSchema)
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
      } satisfies Parameters<typeof skipOccurrence>[0];

      try {
        return await skipOccurrence(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  restoreOccurrence: authedProcedure
    .input(restoreOccurrenceInput)
    .output(restoreOccurrenceResultSchema)
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
      } satisfies Parameters<typeof restoreOccurrence>[0];

      try {
        return await restoreOccurrence(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  addSeriesOccurrence: authedProcedure
    .input(addSeriesOccurrenceInput)
    .output(addSeriesOccurrenceResultSchema)
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
      } satisfies Parameters<typeof addSeriesOccurrence>[0];

      try {
        return await addSeriesOccurrence(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  listSeriesDatesForAdmin: authedProcedure
    .input(listSeriesDatesForAdminInput)
    .output(listSeriesDatesForAdminResultSchema)
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
      } satisfies Parameters<typeof listSeriesDatesForAdmin>[0];

      // Drop the tRPC-injected `direction` before forwarding: the use case
      // re-validates with the strict base schema, which has no `direction`
      // field and would reject it a second time.
      const { direction: _direction, ...rest } = input;

      try {
        return await listSeriesDatesForAdmin(deps, { ...rest, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  cancelEventSeries: authedProcedure
    .input(cancelEventSeriesInputSchema.omit({ actorHumanId: true }))
    .output(cancelEventSeriesResultSchema)
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
        payments: ctx.payments,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof cancelEventSeries>[0];

      try {
        return await cancelEventSeries(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  publicSeriesDates: publicProcedure
    .input(listPublicSeriesDatesInputSchema)
    .output(listPublicSeriesDatesResultSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof listPublicSeriesDates>[0];

      try {
        return await listPublicSeriesDates(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type SeriesRouter = typeof seriesRouter;
