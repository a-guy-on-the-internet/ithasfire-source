import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../../lib/io";
import { ensureActorCanEditSeries } from "./_shared/open-call-anchor";
import { openCallPayKindSchema, payDetailsInputSchema } from "./_shared/open-call-pay";
import { openCallIntroTextSchema, writeOpenCall } from "./_shared/write-open-call";

/**
 * Presence semantics, like the event form upsert: absent = leave unchanged,
 * null = clear.
 */
export const upsertSeriesOpenCallInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    seriesId: z.uuid(),
    introText: openCallIntroTextSchema,
    defaults: z
      .object({
        includeName: z.boolean(),
        includeReason: z.boolean(),
        includeSocialLinks: z.boolean(),
      })
      .optional(),
    opensAt: z.date().nullable().optional(),
    closesAt: z.date().nullable().optional(),
    maxSubmissions: z.number().int().min(1).nullable().optional(),
    payKind: openCallPayKindSchema.nullable().optional(),
    payDetails: payDetailsInputSchema,
  })
  .strict();

export const upsertSeriesOpenCallOutputSchema = z
  .object({
    seriesId: z.uuid(),
    formId: z.uuid(),
    publicId: z.string(),
    introText: z.string().nullable(),
    payKind: openCallPayKindSchema.nullable(),
    payDetails: z.string().nullable(),
    opensAt: z.date().nullable(),
    closesAt: z.date().nullable(),
    maxSubmissions: z.number().int().nullable(),
    closedAt: z.date().nullable(),
    /** Null = a draft call; "Post call" makes it public (Q41). */
    postedAt: z.date().nullable(),
    updatedAt: z.date(),
  })
  .strict();

export type UpsertSeriesOpenCallInput = z.infer<typeof upsertSeriesOpenCallInputSchema>;
export type UpsertSeriesOpenCallOutput = z.infer<typeof upsertSeriesOpenCallOutputSchema>;

export type UpsertSeriesOpenCallDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Create or update a SERIES' open call (open calls Q40: a call belongs to a
 * series or an event; a series call's dates are the series' dates). Auth:
 * series edit rights (`ensureSeriesOwnerAccess`, purpose edit). An archived
 * series takes no call (SERIES_INACTIVE).
 *
 * Refused with SERIES_OPEN_CALL_CONFLICT while any upcoming event of the
 * series holds its own call (FR-001, see `writeOpenCall`).
 */
export async function upsertSeriesOpenCall(
  deps: UpsertSeriesOpenCallDeps,
  rawInput: unknown,
): Promise<UpsertSeriesOpenCallOutput> {
  const input = parseInput(upsertSeriesOpenCallInputSchema, rawInput);

  const { form, created } = await deps.repos.tx(async (tx) => {
    const series = await ensureActorCanEditSeries(
      tx,
      input.seriesId,
      input.actorHumanId,
      deps.logger,
    );
    if (series.archivedAt) {
      throw fail("SERIES_INACTIVE");
    }

    const now = deps.clock.now();
    const written = await writeOpenCall(tx, {
      anchorContext: { kind: "series", series },
      actorHumanId: input.actorHumanId,
      now,
      fields: {
        introText: input.introText,
        defaults: input.defaults,
        opensAt: input.opensAt,
        closesAt: input.closesAt,
        maxSubmissions: input.maxSubmissions,
        payKind: input.payKind,
        payDetails: input.payDetails,
      },
    });

    await tx.audit.log({
      entity: "event_series",
      entityId: series.id,
      action: written.created ? "open_call_created" : "open_call_updated",
      data: {
        actorHumanId: input.actorHumanId,
        formId: written.form.id,
        payKind: written.form.payKind,
      },
      at: now,
    });

    return written;
  });

  deps.logger?.info("open_call", {
    category: "open_call",
    seriesId: input.seriesId,
    formId: form.id,
    action: created ? "created" : "updated",
    actorHumanId: input.actorHumanId,
  });

  return upsertSeriesOpenCallOutputSchema.parse({
    seriesId: input.seriesId,
    formId: form.id,
    publicId: form.publicId,
    introText: form.introText,
    payKind: form.payKind,
    payDetails: form.payDetails,
    opensAt: form.opensAt,
    closesAt: form.closesAt,
    maxSubmissions: form.maxSubmissions,
    closedAt: form.closedAt,
    postedAt: form.postedAt,
    updatedAt: form.updatedAt,
  });
}
