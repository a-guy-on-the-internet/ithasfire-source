import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  ApplicationSubmissionStatus,
  EventGateType,
  EventVisibility,
} from "@th/ports/repos/events";

import { parseInput } from "../../lib/io";
import { ensureActorCanEditEvent } from "./_shared/ensure-actor-can-edit-event";
import { fail } from "@th/errors";
import {
  eventApplicationSubmissionRecordSchema,
  eventApplicationSubmissionStatuses,
} from "./_shared/event-application-submission-schema";

const submissionFiltersSchema = z.object({
  statuses: z
    .array(z.enum(eventApplicationSubmissionStatuses))
    .max(eventApplicationSubmissionStatuses.length)
    .optional(),
});

const paginationSchema = z.object({
  limit: z.number().int().optional(),
  offset: z.number().int().optional(),
});

export const listEventApplicationSubmissionsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    eventId: z.string().uuid(),
  })
  .merge(submissionFiltersSchema)
  .merge(paginationSchema)
  .strict();

const paginationOutputSchema = z.object({
  limit: z.number().int().min(1).max(200),
  offset: z.number().int().min(0),
  count: z.number().int().min(0),
});

const appliedFiltersSchema = z.object({
  statuses: z.array(z.enum(eventApplicationSubmissionStatuses)).nullable(),
});

export const listEventApplicationSubmissionsOutputSchema = z.object({
  eventId: z.string().uuid(),
  submissions: z.array(eventApplicationSubmissionRecordSchema),
  pagination: paginationOutputSchema,
  appliedFilters: appliedFiltersSchema,
});

export type ListEventApplicationSubmissionsInput = z.infer<
  typeof listEventApplicationSubmissionsInputSchema
>;
export type ListEventApplicationSubmissionsOutput = z.infer<
  typeof listEventApplicationSubmissionsOutputSchema
>;

export type ListEventApplicationSubmissionsDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function listEventApplicationSubmissions(
  deps: ListEventApplicationSubmissionsDeps,
  rawInput: unknown,
): Promise<ListEventApplicationSubmissionsOutput> {
  const input = parseInput(
    listEventApplicationSubmissionsInputSchema,
    rawInput,
  );
  const pagination = resolvePagination(input.limit, input.offset);
  const statuses = dedupeStatuses(input.statuses);

  const { event, submissions } = await deps.repos.tx(async (tx) => {
    const editableEvent = await ensureActorCanEditEvent(
      tx,
      input.eventId,
      input.actorHumanId,
    );

    if (editableEvent.gateType !== "APPLICATION") {
      throw fail("EVENT_NOT_APPLICATION_GATED");
    }

    const submissionList = await tx.eventApplications.listSubmissions({
      eventId: editableEvent.id,
      // The attendee review queue: ATTEND form only.
      purpose: "ATTEND",
      statuses: statuses ?? undefined,
      limit: pagination.limit,
      offset: pagination.offset,
    });

    return { event: editableEvent, submissions: submissionList } as const;
  });

  deps.logger?.info("event_gate", {
    category: "event_gate",
    eventId: event.id,
    visibility: event.visibility as EventVisibility,
    gateType: event.gateType as EventGateType,
    action: "application_submissions_listed",
    result: "success",
    actorHumanId: input.actorHumanId,
    metadata: {
      limit: pagination.limit,
      offset: pagination.offset,
      filterStatuses: statuses ?? null,
      count: submissions.items.length,
      total: submissions.pageInfo.total,
    },
  });

  return listEventApplicationSubmissionsOutputSchema.parse({
    eventId: event.id,
    submissions: submissions.items,
    pagination: {
      limit: pagination.limit,
      offset: pagination.offset,
      count: submissions.items.length,
    },
    appliedFilters: {
      statuses: statuses ?? null,
    },
  });
}

function resolvePagination(
  limit?: number,
  offset?: number,
): { limit: number; offset: number } {
  const resolvedLimit = Math.min(Math.max(limit ?? 50, 1), 200);
  const resolvedOffset = Math.max(offset ?? 0, 0);
  return { limit: resolvedLimit, offset: resolvedOffset };
}

function dedupeStatuses(
  statuses: ApplicationSubmissionStatus[] | undefined,
): ApplicationSubmissionStatus[] | null {
  if (!statuses || statuses.length === 0) {
    return null;
  }

  const seen = new Set<ApplicationSubmissionStatus>();
  const result: ApplicationSubmissionStatus[] = [];
  for (const status of statuses) {
    if (seen.has(status)) {
      continue;
    }
    seen.add(status);
    result.push(status);
  }

  return result;
}
