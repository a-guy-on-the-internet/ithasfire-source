# Postgres-backed Multi-index Search

Date: 2026-05-12
Status: Accepted

> Status 2026-10-09: implemented — Postgres is the default search adapter (`SEARCH_BACKEND` defaults to `postgres` in `apps/api/src/lib/env.ts`; the branch is in `apps/api/src/lib/dep.ts`). The Decision text below says the default stays `meili`; that was true on 2026-05-12 and is not now. Meilisearch remains a selectable later option.

## Context

Ithas Fire's unified search has been backed by a Cloud Run Meilisearch service using a GCS Fuse volume. That setup adds an extra service, extra secret/config surface, and a fragile storage dependency for a search workload that is small enough for Postgres to serve directly.

The existing `MultiSearchPort` already isolates autocomplete, indexing, deletes, stats, and health checks from consumers. That boundary lets us add a Postgres implementation without changing search callers or the single-index `SearchQueryPort` behavior.

## Decision

Add a Postgres-backed `MultiSearchPort` implementation behind `SEARCH_BACKEND=postgres`, while keeping the default as `SEARCH_BACKEND=meili`.

The adapter stores all indexed entity types in one `SearchDocument` table and uses generated columns for full-text, trigram, and geo search inputs. Ranking combines full-text, prefix, fuzzy, popularity, and geo signals with env-tunable weights. Prisma migrations own the table and indexes; `ensureIndexes` is a no-op for this backend.

Detailed schema, ranking, and cutover behavior are specified in `docs/specs/2026-05-12/completed/postgres-search-adapter.spec.md`.

## Consequences

- Operations can remove Meilisearch from the unified-search path after a stability window and relevance smoke pass.
- Rollback remains a flag flip while Meilisearch is still deployed and indexed.
- Relevance tuning moves from Meilisearch settings to `SEARCH_W_*` env vars and SQL changes for new ranking dimensions.
- Postgres search now depends on `pg_trgm`, `unaccent`, `cube`, and `earthdistance` being available in the database.