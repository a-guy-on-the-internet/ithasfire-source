import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import { applicationSubmissionStatusSchema } from "@th/schema";

import { parseInput } from "../../../lib/io";
import { resolveOrganizerCall } from "./_shared/organizer-side";
import {
  applicationVoteValueSchema,
  openCallReviewCardSchema,
  projectReviewCard,
  TRACE_LINEUP_ROLES,
  TRACE_ORGANISER_ORG_ROLES,
} from "./_shared/review-card";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export const listOpenCallApplicationsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    /** The call (event call or series call). */
    formId: z.uuid(),
    /**
     * FR-012 filters. There is NO sort parameter: the queue is always time
     * applied, oldest first (principle 6, spread attention).
     */
    filter: z
      .object({
        /** Absent = every status except WITHDRAWN. */
        statuses: z.array(applicationSubmissionStatusSchema).min(1).max(10).optional(),
        /** An occurrence id (series call) or EventDate id (event call). */
        dateId: z.uuid().optional(),
        myVote: z.union([applicationVoteValueSchema, z.literal("NONE")]).optional(),
      })
      .strict()
      .default({}),
    /** The previous page's `nextCursor`. */
    cursor: z.uuid().nullable().optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

export const listOpenCallApplicationsOutputSchema = z
  .object({
    items: z.array(openCallReviewCardSchema),
    nextCursor: z.uuid().nullable(),
  })
  .strict();

export type ListOpenCallApplicationsInput = z.input<typeof listOpenCallApplicationsInputSchema>;
export type ListOpenCallApplicationsOutput = z.infer<typeof listOpenCallApplicationsOutputSchema>;

export type ListOpenCallApplicationsDeps = {
  repos: Pick<Repos, "eventApplications" | "events" | "series" | "authz">;
  clock: ClockPort;
};

/**
 * The organizer side's review queue for one call (FR-012, FR-013).
 *
 * Auth: organizer SIDE (`isOnOrganizerSide`, FR-014), resolved from the
 * form's own anchor. A stranger, a member of another org, an unknown call:
 * all OPEN_CALL_NOT_FOUND.
 *
 * Order: time applied, oldest first, and nothing else (no score, no trace
 * ranking). Filters: status, date chosen, my vote. WITHDRAWN applications
 * appear only when the status filter names WITHDRAWN (FR-012 filters by
 * status; FR-023 keeps every other application visible after close).
 * Stable keyset pagination on (createdAt, id).
 *
 * Cards carry no answers or questions (FR-010): an answer the applicant
 * can still edit is never shown; opening the card shows it and locks it.
 *
 * Read-only: listing NEVER stamps `openedAt` (only opening one card does,
 * `openOpenCallApplication`), so scrolling the queue never locks anyone's
 * edits (FR-010).
 */
export async function listOpenCallApplications(
  deps: ListOpenCallApplicationsDeps,
  rawInput: unknown,
): Promise<ListOpenCallApplicationsOutput> {
  const input = parseInput(listOpenCallApplicationsInputSchema, rawInput);
  const { form } = await resolveOrganizerCall(deps.repos, input.formId, input.actorHumanId);

  const page = await deps.repos.eventApplications.listOpenCallReviewCards({
    formId: form.id,
    viewerHumanId: input.actorHumanId,
    filter: {
      ...(input.filter.statuses ? { statuses: input.filter.statuses } : {}),
      ...(input.filter.dateId ? { dateId: input.filter.dateId } : {}),
      ...(input.filter.myVote ? { myVote: input.filter.myVote } : {}),
    },
    cursor: input.cursor ?? null,
    limit: input.limit,
    now: deps.clock.now(),
    lineupRoles: TRACE_LINEUP_ROLES,
    organiserOrgRoles: TRACE_ORGANISER_ORG_ROLES,
  });

  return listOpenCallApplicationsOutputSchema.parse({
    items: page.items.map(projectReviewCard),
    nextCursor: page.nextCursor,
  });
}
