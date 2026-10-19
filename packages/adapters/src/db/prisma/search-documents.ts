import type { PrismaClient } from "@prisma/client";

import type { SearchDocumentsWriter } from "@th/ports/search/multi-index.port";

import { MultiIndexPostgresAdapter } from "../../search/multi-index-postgres-adapter";
import type { PrismaClientOrTx } from "./types";

/**
 * `Repos.searchDocuments`: the Postgres search adapter's document writes, run
 * on THIS client. Built per `makeTxRepos` call, so inside `repos.tx` the
 * writes go through the transaction's connection and commit or roll back
 * with it (the search index write fence and the privacy scrub depend on
 * that). Same SQL as the root adapter — it is the same class; only the
 * client differs. The interactive-transaction client exposes the
 * `$executeRaw` / `$queryRaw` the adapter's writes use.
 */
export function makeSearchDocumentsWriter(
  p: PrismaClientOrTx,
): SearchDocumentsWriter {
  const adapter = new MultiIndexPostgresAdapter({
    prisma: p as PrismaClient,
  });
  return {
    upsertDocuments: (input) => adapter.upsertDocuments(input),
    deleteDocuments: (input) => adapter.deleteDocuments(input),
  };
}
