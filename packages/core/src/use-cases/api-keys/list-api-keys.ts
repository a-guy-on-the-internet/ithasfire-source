import type { Repos } from "@th/ports/repos";
import type { LoggerPort } from "@th/ports/logger";

import { parseInput } from "../../lib/io";
import { listApiKeysInputSchema, type ListApiKeysOutput } from "./schemas";

export type ListApiKeysDeps = {
  repos: Pick<Repos, "apiKeys">;
  logger?: LoggerPort;
};

const DEFAULT_LIMIT = 25;

/**
 * @deprecated Legacy list (no scope, status or request). Replaced by
 * `listMyApiKeys`; kept because the router still imports it until plan step 5.
 */
export async function listApiKeys(
  deps: ListApiKeysDeps,
  rawInput: unknown,
): Promise<ListApiKeysOutput> {
  const input = parseInput(listApiKeysInputSchema, rawInput);

  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = input.offset ?? 0;

  const { items, total } = await deps.repos.apiKeys.listByHuman({
    humanId: input.actorHumanId,
    limit,
    offset,
  });

  const count = items.length;
  const hasNextPage = offset + count < total;

  return {
    items: items.map((item) => ({
      id: item.id,
      label: item.label,
      createdAt: item.createdAt,
      lastUsedAt: item.lastUsedAt,
      revokedAt: item.revokedAt,
    })),
    pageInfo: {
      total,
      count,
      limit,
      offset,
      hasNextPage,
      nextOffset: hasNextPage ? offset + count : null,
    },
  } satisfies ListApiKeysOutput;
}
