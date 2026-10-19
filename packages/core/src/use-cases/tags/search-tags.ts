import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

export const searchTagsInput = z.object({
  query: z.string().min(1).max(64),
  limit: z.number().int().min(1).max(50).default(20),
});

const tagRecordSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
});

export const searchTagsOutput = z.object({
  tags: z.array(tagRecordSchema),
});

export type SearchTagsInput = z.infer<typeof searchTagsInput>;
export type SearchTagsOutput = z.infer<typeof searchTagsOutput>;

export type SearchTagsDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function searchTags(
  deps: SearchTagsDeps,
  rawInput: unknown,
): Promise<SearchTagsOutput> {
  const input = parseInput(searchTagsInput, rawInput);

  const tags = await deps.repos.tags.search(input.query, {
    limit: input.limit,
  });

  return searchTagsOutput.parse({
    tags: tags.map((t) => ({ id: t.id, slug: t.slug, name: t.name })),
  });
}
