import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ── Schema ────────────────────────────────────────────────────────────────

export const getEventWaiverInputSchema = z
  .object({
    eventId: z.string().uuid(),
  })
  .strict();

export const getEventWaiverOutputSchema = z.object({
  waiver: z
    .object({
      id: z.string().uuid(),
      name: z.string(),
      body: z.string(),
      version: z.number().int(),
    })
    .nullable(),
});

export type GetEventWaiverInput = z.infer<typeof getEventWaiverInputSchema>;
export type GetEventWaiverOutput = z.infer<typeof getEventWaiverOutputSchema>;

export type GetEventWaiverDeps = {
  repos: Pick<Repos, "events" | "waiverTemplates">;
  logger?: LoggerPort;
};

// ── Use case ──────────────────────────────────────────────────────────────

/**
 * Public use case — no auth required.
 * Returns the waiver body and metadata for an event, or null if none.
 *
 * Only for an event someone can BUY: PUBLISHED with an owner in good
 * standing, the same bar as checkout's `ensureEventOnSale`. A DRAFT or a
 * banned owner's event is EVENT_NOT_FOUND, like a missing id, so this is not
 * a way to read their text. The gate (PASSWORD / APPLICATION) is enforced at
 * the transport (`ensureFullEventReadAccessByEventId`), which reads the
 * viewer's grant cookies and session.
 */
export async function getEventWaiver(
  deps: GetEventWaiverDeps,
  rawInput: unknown,
): Promise<GetEventWaiverOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "getEventWaiver" });

  const execute = async (): Promise<GetEventWaiverOutput> => {
    const input = parseInput(getEventWaiverInputSchema, rawInput);

    const event = await deps.repos.events.getById(input.eventId, {
      withOwnerStanding: true,
    });
    if (!event || event.status !== "PUBLISHED" || event.ownerBanned === true) {
      throw fail("EVENT_NOT_FOUND");
    }

    if (!event.waiverTemplateId) {
      return { waiver: null };
    }

    const template = await deps.repos.waiverTemplates.getById(
      event.waiverTemplateId,
    );
    if (!template) {
      // Template was deleted after being assigned — treat as no waiver
      return { waiver: null };
    }

    return getEventWaiverOutputSchema.parse({
      waiver: {
        id: template.id,
        name: template.name,
        body: template.body,
        version: template.version,
      },
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("getEventWaiver", execute);
  }

  return execute();
}
