import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../../lib/io";
import {
  applicationMessageSchema,
  applicationThreadPartySchema,
  projectApplicationMessage,
  resolveThreadParty,
  threadIsReadOnly,
} from "./_shared/application-thread";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export const listApplicationMessagesInputSchema = z
  .object({
    party: applicationThreadPartySchema,
    cursor: z.uuid().nullable().optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

export const listApplicationMessagesOutputSchema = z
  .object({
    items: z.array(applicationMessageSchema),
    nextCursor: z.uuid().nullable(),
    /** True when the thread takes no new messages (WITHDRAWN). */
    readOnly: z.boolean(),
  })
  .strict();

export type ListApplicationMessagesInput = z.input<typeof listApplicationMessagesInputSchema>;
export type ListApplicationMessagesOutput = z.infer<typeof listApplicationMessagesOutputSchema>;

export type ListApplicationMessagesDeps = {
  repos: Pick<
    Repos,
    "eventApplications" | "events" | "series" | "eventDates" | "seriesOccurrences" | "authz"
  >;
  clock: ClockPort;
};

/**
 * One page of an application's thread, oldest first; cursor = the last
 * message id (FR-015, mirroring listBookingRequestMessages). Either side,
 * same auth as posting. Works on a read-only (WITHDRAWN) thread.
 *
 * Read-only: does NOT stamp read markers (`markApplicationMessagesRead`
 * does), so polling never mutates, and does NOT stamp `openedAt`.
 */
export async function listApplicationMessages(
  deps: ListApplicationMessagesDeps,
  rawInput: unknown,
): Promise<ListApplicationMessagesOutput> {
  const input = parseInput(listApplicationMessagesInputSchema, rawInput);
  const party = await resolveThreadParty(deps.repos, input.party, deps.clock.now());
  const page = await deps.repos.eventApplications.listApplicationMessages({
    submissionId: party.submission.id,
    cursor: input.cursor ?? null,
    limit: input.limit,
  });
  return listApplicationMessagesOutputSchema.parse({
    items: page.items.map((row) => projectApplicationMessage(row, party.side)),
    nextCursor: page.nextCursor,
    readOnly: threadIsReadOnly(party.submission),
  });
}
