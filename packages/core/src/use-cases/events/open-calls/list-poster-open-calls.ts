import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../../lib/io";
import { openCallPayKindSchema } from "./_shared/open-call-pay";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;

export const listPosterOpenCallsInputSchema = z
  .object({
    poster: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("org"), orgId: z.uuid() }).strict(),
      z.object({ kind: z.literal("human"), humanId: z.uuid() }).strict(),
    ]),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  })
  .strict();

export const listPosterOpenCallsOutputSchema = z
  .object({
    calls: z.array(
      z
        .object({
          publicId: z.string(),
          anchor: z.enum(["event", "series"]),
          title: z.string(),
          payKind: openCallPayKindSchema.nullable(),
          closesAt: z.date().nullable(),
          nextStartsAt: z.date(),
          timezone: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export type ListPosterOpenCallsInput = z.infer<typeof listPosterOpenCallsInputSchema>;
export type ListPosterOpenCallsOutput = z.infer<typeof listPosterOpenCallsOutputSchema>;

export type ListPosterOpenCallsDeps = {
  repos: Pick<Repos, "eventApplications">;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * The open calls an org or a person posted, for their public page (open
 * calls FR-003: "the poster's public page lists its open calls"). No auth;
 * the page that renders it owns its own visibility.
 *
 * Lists a call while it can still be applied to: not closed, on a PUBLIC
 * event that is not cancelled / archived / completed and has not started, or
 * on an unarchived series with a live date to come. A draft event's call IS
 * listed (a call is public while its event is a draft, FR-003 / Q11), but a
 * PRIVATE event's call is not: its link still works, it just isn't
 * advertised on the page. A banned poster lists nothing.
 *
 * Card fields only (title, pay kind, deadline, next date, link id): no event
 * id or slug, no applicant data.
 */
export async function listPosterOpenCalls(
  deps: ListPosterOpenCallsDeps,
  rawInput: unknown,
): Promise<ListPosterOpenCallsOutput> {
  const input = parseInput(listPosterOpenCallsInputSchema, rawInput);
  const rows = await deps.repos.eventApplications.listOpenCallsByPoster({
    poster: input.poster,
    now: deps.clock.now(),
    limit: input.limit ?? DEFAULT_LIMIT,
  });
  return listPosterOpenCallsOutputSchema.parse({
    calls: rows.map((row) => ({
      publicId: row.publicId,
      anchor: row.anchor.kind,
      title: row.title,
      payKind: row.payKind,
      closesAt: row.closesAt,
      nextStartsAt: row.nextStartsAt,
      timezone: row.timezone,
    })),
  });
}
