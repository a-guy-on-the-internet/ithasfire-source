import { z } from "zod";

import { parseInput } from "../../lib/io";
import { GENRE_JOBS } from "../../lib/human-jobs";
import {
  plainTextOptional,
  plainTextRequired,
} from "../../lib/sanitize-plain-text";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

const HUMAN_JOB_VALUES = [
  "MUSICIAN",
  "DJ",
  "COMEDIAN",
  "DANCER",
  "VISUAL_ARTIST",
  "POET",
  "MAGICIAN",
  "SOUND_ENGINEER",
  "LIGHTING_ENGINEER",
  "PHOTOGRAPHER",
  "VIDEOGRAPHER",
  "PROMOTER",
  "EVENT_ORGANIZER",
  "BOOKING_AGENT",
  "OTHER",
] as const;

export const updateHumanJobsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    jobs: z.array(z.enum(HUMAN_JOB_VALUES)),
    // Free text that feeds PUBLIC payloads (the entity-page HUMAN summary) —
    // sanitize BEFORE the length checks with the house plainText helpers
    // (pattern: entity-pages/block-config.ts). Same max lengths as before.
    genreTags: z.array(plainTextRequired(100)).max(20).default([]),
    otherJobDescription: plainTextOptional(200).nullable().default(null),
  })
  .strict();

export const updateHumanJobsOutputSchema = z
  .object({
    jobs: z.array(z.string()),
    genreTags: z.array(z.string()),
  })
  .strict();

export type UpdateHumanJobsInput = z.infer<typeof updateHumanJobsInputSchema>;
export type UpdateHumanJobsOutput = z.infer<typeof updateHumanJobsOutputSchema>;

export type UpdateHumanJobsDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function updateHumanJobs(
  deps: UpdateHumanJobsDeps,
  rawInput: unknown,
): Promise<UpdateHumanJobsOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "updateHumanJobs" });

  const execute = async () => {
    const input = parseInput(updateHumanJobsInputSchema, rawInput);

    // Verify the human exists
    const existing = await deps.repos.humans.getById(input.actorHumanId);
    if (!existing) {
      throw fail("HUMAN_NOT_FOUND");
    }

    let { genreTags, otherJobDescription } = input;
    let jobs = [...new Set(input.jobs)];

    // Normalize: strip otherJobDescription when OTHER is not in jobs
    if (!jobs.includes("OTHER")) {
      otherJobDescription = null;
    }

    // Normalize: strip genreTags when no GENRE_JOBS member is present
    // TODO: GENRE_JOBS should be Set<string> to avoid cast; safe because j is already validated by Zod
    const hasGenreJob = jobs.some((j) => GENRE_JOBS.has(j as any));
    if (!hasGenreJob) {
      genreTags = [];
    }

    const updated = await deps.repos.humans.updateJobs(input.actorHumanId, {
      jobs,
      genreTags,
      otherJobDescription,
    });

    return { jobs: updated.jobs, genreTags: updated.genreTags };
  };

  if (scopedLogger) {
    return scopedLogger.withTime("updateHumanJobs", execute);
  }

  return execute();
}
