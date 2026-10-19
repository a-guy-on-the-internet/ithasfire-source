import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { HumanPerformanceSummary } from "@th/types/repos/event-humans";

import { parseInput } from "../../lib/io";
import { PUBLIC_LINEUP_ROLES } from "../../lib/event-human-roles";

/** Cap on how many past shows are surfaced (FR-002; "view all" is out of scope). */
export const PAST_SHOWS_LIMIT = 20;

export const listHumanShowsInputSchema = z
  .object({
    humanId: z.string().min(1),
    when: z.enum(["upcoming", "past"]),
  })
  .strict();

export const humanShowSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    /** ISO timestamp. */
    date: z.string(),
    venueName: z.string().nullable(),
    slug: z.string().optional(),
  })
  .strict();

export const listHumanShowsOutputSchema = z.array(humanShowSummarySchema);

export type ListHumanShowsInput = z.infer<typeof listHumanShowsInputSchema>;
export type HumanShowSummary = z.infer<typeof humanShowSummarySchema>;
export type ListHumanShowsOutput = z.infer<typeof listHumanShowsOutputSchema>;

export type ListHumanShowsDeps = {
  repos: Pick<Repos, "eventHumans">;
  logger?: LoggerPort;
};

/**
 * Canonical mapper from a repo performance summary to the event-summary shape
 * consumed by the `shows` / `past_shows` block renderers. Shared by this use
 * case AND the server-side block injection in get-my-page / get-public-page so
 * the two never diverge.
 */
export function toHumanShowSummary(
  performance: HumanPerformanceSummary,
): HumanShowSummary {
  return {
    id: performance.eventId,
    title: performance.title,
    date: performance.startsAt.toISOString(),
    venueName: performance.venueName,
    ...(performance.slug ? { slug: performance.slug } : {}),
  };
}

/**
 * List a Human's PUBLISHED, publicly-visible shows (FR-001 / FR-002), split by
 * date. Thin wrapper over `eventHumans.listPerformancesByHuman` — filters to
 * `PUBLIC_LINEUP_ROLES` (any public-lineup credit lists the show; volunteers
 * excluded), dedupes by event (in the repo), and maps to the renderer shape.
 * `now` is read here (not injected) to mirror the other public derived-block
 * data paths in get-public-page.
 */
export async function listHumanShows(
  deps: ListHumanShowsDeps,
  rawInput: unknown,
): Promise<ListHumanShowsOutput> {
  const input = parseInput(listHumanShowsInputSchema, rawInput);

  const performances = await deps.repos.eventHumans.listPerformancesByHuman({
    humanId: input.humanId,
    roles: PUBLIC_LINEUP_ROLES,
    when: input.when,
    now: new Date(),
    limit: input.when === "past" ? PAST_SHOWS_LIMIT : undefined,
  });

  return listHumanShowsOutputSchema.parse(
    performances.map(toHumanShowSummary),
  );
}
