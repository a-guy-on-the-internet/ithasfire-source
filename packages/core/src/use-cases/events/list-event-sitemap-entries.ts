import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

export const listEventSitemapEntriesInputSchema = z
  .object({
    limit: z.number().int().min(1).max(50000).optional(),
  })
  .strict();

export const listEventSitemapEntriesOutputSchema = z.array(
  z.object({
    slug: z.string(),
    updatedAt: z.string().nullable().optional(),
  }),
);

export type ListEventSitemapEntriesInput = z.infer<
  typeof listEventSitemapEntriesInputSchema
>;
export type ListEventSitemapEntriesOutput = z.infer<
  typeof listEventSitemapEntriesOutputSchema
>;

export type ListEventSitemapEntriesDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function listEventSitemapEntries(
  deps: ListEventSitemapEntriesDeps,
  rawInput: unknown,
): Promise<ListEventSitemapEntriesOutput> {
  const input = parseInput(listEventSitemapEntriesInputSchema, rawInput);

  const records = await deps.repos.events.listPublishedForSitemap({
    limit: input.limit ?? 50000,
    now: new Date(),
  });

  deps.logger?.info("events.list_sitemap_entries", { count: records.length });

  return listEventSitemapEntriesOutputSchema.parse(
    records.map((r) => ({
      slug: r.slug,
      updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
    })),
  );
}
