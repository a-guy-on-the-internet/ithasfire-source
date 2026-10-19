import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { eventEditSuggestionStatusSchema } from "@th/schema";

import { parseInput } from "../../lib/io";

/**
 * Submitter-facing "my edit suggestions" query: a signed-in human sees the
 * status of every edit suggestion THEY submitted (all statuses:
 * PENDING/APPROVED/REJECTED), newest first, each hydrated with the target
 * event's title + current slug. Thin wrapper over
 * `eventEditSuggestions.listBySubmitter` — no authz branch beyond "you can only
 * ever see your own rows" (the repo filters by the actor's own humanId).
 */

export const listMyEditSuggestionsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    cursor: z.string().min(1).nullable().optional(),
    // Ceiling matches the transport cursorPageInput (.max(100)) so a client
    // requesting 51–100 is clamped by the repo, not rejected here.
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const listMyEditSuggestionsOutputSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string(),
          eventId: z.string(),
          eventTitle: z.string(),
          eventSlug: z.string().nullable(),
          status: eventEditSuggestionStatusSchema,
          fields: z.record(z.string(), z.unknown()),
          baseVersion: z.record(z.string(), z.unknown()),
          conflictedFields: z.array(z.string()).nullable(),
          reviewNote: z.string().nullable(),
          createdAt: z.date(),
          reviewedAt: z.date().nullable(),
        })
        .strict(),
    ),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type ListMyEditSuggestionsInput = z.infer<
  typeof listMyEditSuggestionsInputSchema
>;
export type ListMyEditSuggestionsOutput = z.infer<
  typeof listMyEditSuggestionsOutputSchema
>;

export type ListMyEditSuggestionsDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function listMyEditSuggestions(
  deps: ListMyEditSuggestionsDeps,
  rawInput: unknown,
): Promise<ListMyEditSuggestionsOutput> {
  const scopedLogger = deps.logger?.child({
    useCase: "listMyEditSuggestions",
  });

  const execute = async (): Promise<ListMyEditSuggestionsOutput> => {
    const input = parseInput(listMyEditSuggestionsInputSchema, rawInput);

    const page = await deps.repos.eventEditSuggestions.listBySubmitter({
      submitterHumanId: input.actorHumanId,
      cursor: input.cursor ?? null,
      limit: input.limit,
    });

    const items = page.items.map((suggestion) => ({
      id: suggestion.id,
      eventId: suggestion.eventId,
      eventTitle: suggestion.eventTitle,
      eventSlug: suggestion.eventSlug,
      status: suggestion.status,
      fields: suggestion.fields,
      baseVersion: suggestion.baseVersion,
      conflictedFields: suggestion.conflictedFields,
      reviewNote: suggestion.reviewNote,
      createdAt: suggestion.createdAt,
      reviewedAt: suggestion.reviewedAt,
    }));

    return listMyEditSuggestionsOutputSchema.parse({
      items,
      nextCursor: page.nextCursor,
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listMyEditSuggestions", execute);
  }

  return execute();
}
