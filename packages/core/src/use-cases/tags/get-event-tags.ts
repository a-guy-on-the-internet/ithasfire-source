import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

export const getEventTagsInput = z.object({
  eventId: z.string().uuid(),
});

const tagRecordSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
});

export const getEventTagsOutput = z.object({
  tags: z.array(tagRecordSchema),
});

export type GetEventTagsInput = z.infer<typeof getEventTagsInput>;
export type GetEventTagsOutput = z.infer<typeof getEventTagsOutput>;

export type GetEventTagsDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function getEventTags(
  deps: GetEventTagsDeps,
  rawInput: unknown,
): Promise<GetEventTagsOutput> {
  const input = parseInput(getEventTagsInput, rawInput);

  const eventTags = await deps.repos.tags.getEventTags(input.eventId);

  return getEventTagsOutput.parse({
    tags: eventTags.map((et) => ({
      id: et.tag.id,
      slug: et.tag.slug,
      name: et.tag.name,
    })),
  });
}
