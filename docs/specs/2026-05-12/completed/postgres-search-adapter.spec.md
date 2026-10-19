# Postgres-backed `MultiSearchPort` — adapter swap to retire Meilisearch

**Date:** 2026-05-12
**Status:** complete
**Priority:** P1 (operational pain)
**Depends on:** `MultiSearchPort` (`packages/ports/src/search/multi-index.port.ts:22-66`), `MultiSearchDocument` types (`packages/ports/src/search/multi-index.types.ts:18-176`), `build-search-index` use case (`packages/core/src/use-cases/search/build-search-index.ts`)
**Supersedes:** N/A (preserves the port contract introduced in `docs/specs/2025-12-14/event-search-port.spec.yaml` and the indexer in `event-search-indexing.spec.yaml`)

---

## Problem

Ithas Fire's search runs on a Cloud Run Meilisearch instance backed by GCS Fuse. The Fuse mount has been flaking — write latencies spike, the indexer occasionally observes phantom index-not-found errors after restarts, and the operational story for keeping Meili healthy in a Cloud Run / Fuse topology is fragile. We pay this cost for a feature surface (autocomplete + filters + geo) that Postgres can serve directly.

Three pressure points:

1. **GCS Fuse instability** on the Meili Cloud Run pod (the immediate trigger).
2. **Two services** to keep alive when Postgres alone could do the job — extra deploy surface, extra secrets, extra failure modes.
3. **Two adapters in the tree are both Meili** (`meilisearch-adapter.ts` legacy single-index, `multi-index-meilisearch-adapter.ts` current). There is no Postgres adapter today; the swap is greenfield, not a refactor.

The port boundary (`MultiSearchPort`) makes this a contained swap rather than a rewrite — every consumer already speaks the abstract interface.

## Goals

- Implement `MultiSearchPort` against Postgres so we can flip a single env flag and decommission the Meili Cloud Run service.
- Preserve every existing feature the Meili adapter exposes: autocomplete, type/geo/region/date/tag/price/scope filters, popularity-aware ranking, typo tolerance.
- Keep the cutover safe — env-flag switch, no dual-write, easy rollback while Meili is still alive.
- Document the trade-offs so we're explicit about what "good enough" means.

## Non-Goals

- Matching Meili's BM25 + custom ranking-rules sophistication 1:1. We accept a pragmatic relevance model with named tuning knobs.
- Building a new search UX. The transport contract and consumer code do not change.
- Migrating away from Neon. The plan assumes the Neon Postgres extensions catalog (which includes `pg_trgm`, `unaccent`, `cube`, `earthdistance`).

## Context

| Surface | File |
|---|---|
| Query port (autocomplete, health) | `packages/ports/src/search/multi-index.port.ts:22-35` |
| Index port (upsert, delete, stats, ensureIndexes) | `packages/ports/src/search/multi-index.port.ts:40-66` |
| Document type definitions | `packages/ports/src/search/multi-index.types.ts:18-176` |
| Filter inputs | `packages/ports/src/search/multi-index.types.ts:182-205` |
| Current Meili adapter — index config & write path | `packages/adapters/src/search/multi-index-meilisearch-adapter.ts:165-233` |
| Current Meili adapter — query path | `packages/adapters/src/search/multi-index-meilisearch-adapter.ts:239-340` |
| Current Meili adapter — `buildSearchParams` filter compiler | `packages/adapters/src/search/multi-index-meilisearch-adapter.ts:717-834` |
| Indexer that produces documents | `packages/core/src/use-cases/search/build-search-index.ts:200-489` |
| Adapter construction sites | `apps/api/src/lib/dep.ts:553`, `apps/jobs/src/lib/container.ts:178`, `apps/api/src/scripts/seed/seed-data.ts:724`, `apps/api/src/routes/e2e/seed-unified-search.ts:309` |
| Prisma datasource (no extensions enabled yet) | `packages/db/prisma/schema.prisma:11-13` |

## Design

### A. Single `SearchDocument` table, not per-type

One physical table holds all four document types (event / human / place / organization). Per-type tables look cleaner up front but force a `UNION ALL` at every autocomplete, complicate ranking across types, and replicate index DDL four times. The `MultiSearchPort` already speaks "documents," not "rows" — the storage shape should follow.

Generated columns inside the table handle the expensive derivations so they live next to the row, not in the application:

- `search_vector TSVECTOR` — concatenated, weighted full-text vector for ranking.
- `trigram_corpus TEXT` — separate concatenation used by `pg_trgm`'s `%` similarity operator for typo tolerance (different operator family from tsvector — needs its own input).
- `geo_point cube` — precomputed `ll_to_earth(lat, lng)` for `earthdistance` index pruning.

Field weights on the tsvector match the Meili ranking intent today:

| Weight | Fields | Why |
|---|---|---|
| A | `title` | Event title, human displayName, place name, org name — the primary identifier |
| B | `subtitle`, `username` | Venue/address, bio, Better Auth handle |
| C | `tags` | Category slugs + free-form event tags |
| D | `summary`, `city`, `helper` | Long-form description, secondary location, footnotes |

### B. Geo via `earthdistance`, not PostGIS

Neon supports both. `earthdistance` is dramatically lighter — no separate `geometry` schema, no SRID dance, smaller indexes, and ~0.3% error at typical event-discovery scales (well within "events near me" tolerances). We pair `earth_box(...)` for index pruning with `earth_distance(...)` for exact filtering and distance-ascending sort when a geo filter is present. The generated column is named `geo_point` so a future swap to PostGIS would touch the migration and adapter SQL only — no API change.

### C. Indexes — one GIN per analysis mode

- `GIN (search_vector)` — tsvector full-text
- `GIN (trigram_corpus gin_trgm_ops)` — pg_trgm fuzzy
- `GIST (geo_point)` — earthdistance radius pruning
- `GIN (tags)` — array overlap (`&&`) for event tag filtering
- Single-column btrees on `type`, `region_code`, `starts_at`, `org_id`, `owner_human_id`, `popularity_score DESC`

The partial-index conditions (`WHERE type = 'event'` etc.) keep the small indexes small — humans/places don't pay for the `starts_at` index.

### D. One parameterised query for autocomplete

Two modes (prefix typeahead, browse with empty `q`) collapse into one SQL template by gating the text-match clauses on `q != ''`. The composite score:

```
score =
  CASE WHEN q = '' THEN 0
       ELSE ts_rank_cd(search_vector, websearch_to_tsquery('simple', q))             * $w_fulltext
            + ts_rank_cd(search_vector, to_tsquery('simple', quote_literal(q) || ':*')) * $w_prefix
            + similarity(trigram_corpus, q)                                          * $w_fuzzy
  END
  + ln(1 + popularity_score) * $w_popularity
  + CASE WHEN geo present
         THEN 1.0 / (1.0 + distance_km) * $w_geo
         ELSE 0
    END
```

Default weights — sane starting values, tunable via env (see §D.1):

| Knob | Env var | Default | Why |
|---|---|---:|---|
| `$w_fulltext`   | `SEARCH_W_FULLTEXT`   | `1.0`  | Baseline. `ts_rank_cd` (cover density) outperforms `ts_rank` for short typeahead phrases. |
| `$w_prefix`     | `SEARCH_W_PREFIX`     | `0.7`  | Prefix-match clause — `to_tsquery(q || ':*')` matches "coachell" → "Coachella" the moment the user stops typing. Without this, prefix-with-typo (which is most autocomplete inputs) only matches via the fuzzy clause, which weights "similar overall" instead of "starts with what I typed." This is the gap a user would feel vs. Meili. |
| `$w_fuzzy`      | `SEARCH_W_FUZZY`      | `0.5`  | Adds typo tolerance without overwhelming exact matches. `pg_trgm`'s `%` operator gates inclusion; `similarity()` orders within the fuzzy bucket. |
| `$w_popularity` | `SEARCH_W_POPULARITY` | `0.05` | Log-scaled popularity nudge. Linear would bury fresh-but-niche events under a handful of high-volume ones. |
| `$w_geo`        | `SEARCH_W_GEO`        | `1.0`  | Reciprocal-distance bonus when geo filter is present. Close events get a meaningful boost; far events aren't punished if the textual score is strong. |

The query must safely interpolate `q` into the `:*` prefix tsquery. Use `quote_literal(regexp_replace(q, '[^[:alnum:][:space:]]', ' ', 'g'))` (or equivalent parameter-safe stripping) before concatenating — `to_tsquery` is unforgiving about punctuation. `websearch_to_tsquery` handles raw user input directly; the prefix clause is the only one that needs sanitising.

### D.1 Tunable weights without redeploy

The five weights are exposed as env vars (`SEARCH_W_*`) so we can adjust ranking without a code change. The adapter reads them once at construction with the defaults above. This is the single biggest operational delta vs. Meili's settings endpoint — it doesn't give us hot-reload of arbitrary new ranking rules, but it does mean "make popularity matter 2× more" is an env-var bump and a Cloud Run revision roll, not a code-and-PR cycle.

For new ranking signals (a sixth dimension we haven't thought of yet), code change is still required. Document any future weight additions in this spec's append log.

Order rules:

1. **When geo filter present:** distance ASC, score DESC, popularity DESC, title ASC.
2. **Otherwise:** score DESC, popularity DESC, title ASC.

Always-on visibility guards (`event_status = 'PUBLISHED'`, `is_public = true`, `place_status = 'ACTIVE'`) sit inside the WHERE so an empty filter set still produces safe results.

The `websearch_to_tsquery` flavor is the right choice for end-user input: tolerates quoted phrases, `OR` keyword, leading `-` for negation, and won't throw on malformed input. We use the `'simple'` text-search config (not `'english'`) to avoid stemming surprises on proper nouns and venue names — `"running event"` should not collapse to `"run event"` for a ticketing surface where "Running of the Bulls" and "Run Club Meetup" are distinct intents.

### E. Confidence score

The port returns a 0–1 `confidence` per suggestion. Replicate the Meili adapter's `calculateConfidence` logic against our `score` — divide by the session high-water mark within the result set so the top hit is always 1.0 and the tail trends to 0. No new contract.

### F. Writes and deletes

`upsertDocuments({documents, mode})`:
- Single batched `INSERT … ON CONFLICT (id) DO UPDATE SET …`.
- Generated columns are not in the column list; Postgres recomputes them.
- Batch size 200 to stay well under Postgres' 65k prepared-statement parameter ceiling.
- `mode: "replace"` is functionally identical to `"merge"` for our shape (all columns are present in every document); we honor the input but don't branch behavior.

`deleteDocuments`:
- `WHERE id = ANY($1)` for ids.
- `WHERE type = $1` for full-type wipes.
- `WHERE org_id = $1` / `WHERE owner_human_id = $1` for ownership scopes (events only — both columns are null on other types so the predicate is naturally type-scoped).

`getStats`:
- `SELECT type, COUNT(*), MAX(indexed_at) FROM "SearchDocument" GROUP BY type`. Four rows.

`ensureIndexes`:
- No-op in production. Prisma migrations own DDL. We document this and return `ok(undefined)` to satisfy the port — callers don't branch.
- In test/dev, the migration is idempotent; a fresh DB picks it up via `prisma migrate deploy`.

### G. Cutover — env-flag switch

```
SEARCH_BACKEND = "meili" | "postgres"   // default "meili"
```

Wired in `apps/api/src/lib/dep.ts`, `apps/jobs/src/lib/container.ts`, and the two seed scripts. No call-site changes — every consumer already depends on the port.

1. Land schema migration + adapter behind the flag, default still `meili`.
2. Reindex Postgres in parallel: run `search.full-reindex` with `SEARCH_BACKEND=postgres`. Builds a parallel index without touching Meili.
3. Smoke locally + dev with `SEARCH_BACKEND=postgres`. Verify: `/search` autocomplete, home tiered-popular, category routes, admin event filters (`ownerHumanId` scope).
4. **Side-by-side relevance spike.** Pull the top 10–20 real user queries from the last 30 days of search logs (or hand-pick 10 representative ones if logs are thin). Run each through both adapters via a one-off script and compare top-10 results. Two acceptance bars:
   - **Hard fail (blocks flip):** any query where the Postgres adapter returns zero results when Meili returns ≥1 relevant result. Means coverage is broken.
   - **Soft fail (tune before flip):** any query where the user-intent top result on Meili doesn't appear in Postgres' top-10. Means weights need adjustment via the `SEARCH_W_*` knobs.
   Save the comparison as a checked-in artefact (`docs/decisions/postgres-search-relevance-spike.md`) so the next debate about ranking has a baseline.
5. Flip prod via env update.
6. After a **3-week** stability window — long enough to catch a weekly rollup cycle and any monthly seasonal-event traffic spike — tear down the Meili Cloud Run service and GCS Fuse mount.

No dual-write needed — the reindexer is the source of truth. Rollback is a flag flip while Meili is still alive.

## Schema

### Migration sketch

`packages/db/prisma/migrations/20260512_search_documents/migration.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;

CREATE TABLE "SearchDocument" (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  helper TEXT,
  image_url TEXT,
  event_id TEXT,
  human_id TEXT,
  place_id TEXT,
  org_id_ref TEXT,
  slug TEXT,
  username TEXT,
  profile_slug TEXT,
  org_slug TEXT,
  starts_at TIMESTAMPTZ,
  event_status TEXT,
  region_code TEXT,
  country_code TEXT,
  city TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  tags TEXT[] NOT NULL DEFAULT '{}',
  artists TEXT[] NOT NULL DEFAULT '{}',
  venue_name TEXT,
  org_id TEXT,
  owner_human_id TEXT,
  summary TEXT,
  popularity_score INT NOT NULL DEFAULT 0,
  lowest_price_cents INT,
  lowest_buyer_total_cents INT,
  currency TEXT,
  paid_tier_count INT NOT NULL DEFAULT 0,
  has_free_tier BOOLEAN NOT NULL DEFAULT FALSE,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  events_hosted_count INT NOT NULL DEFAULT 0,
  capacity INT,
  event_count INT NOT NULL DEFAULT 0,
  place_status TEXT,
  verification_status TEXT,
  listed_in_directory BOOLEAN NOT NULL DEFAULT FALSE,
  org_status TEXT,
  member_count INT NOT NULL DEFAULT 0,

  search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', unaccent(coalesce(title,    ''))), 'A') ||
    setweight(to_tsvector('simple', unaccent(coalesce(subtitle, ''))), 'B') ||
    setweight(to_tsvector('simple', unaccent(coalesce(username, ''))), 'B') ||
    setweight(to_tsvector('simple', unaccent(coalesce(array_to_string(tags, ' '), ''))), 'C') ||
    setweight(to_tsvector('simple', unaccent(coalesce(summary,  ''))), 'D') ||
    setweight(to_tsvector('simple', unaccent(coalesce(city,     ''))), 'D') ||
    setweight(to_tsvector('simple', unaccent(coalesce(helper,   ''))), 'D')
  ) STORED,

  trigram_corpus TEXT GENERATED ALWAYS AS (
    unaccent(coalesce(title,'') || ' ' || coalesce(subtitle,'') || ' ' || coalesce(username,''))
  ) STORED,

  geo_point cube GENERATED ALWAYS AS (
    CASE WHEN lat IS NOT NULL AND lng IS NOT NULL
         THEN ll_to_earth(lat, lng)
    END
  ) STORED,

  indexed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX search_doc_tsv_idx          ON "SearchDocument" USING GIN  (search_vector);
CREATE INDEX search_doc_trigram_idx      ON "SearchDocument" USING GIN  (trigram_corpus gin_trgm_ops);
CREATE INDEX search_doc_geo_idx          ON "SearchDocument" USING GIST (geo_point);
CREATE INDEX search_doc_tags_idx         ON "SearchDocument" USING GIN  (tags);
CREATE INDEX search_doc_type_idx         ON "SearchDocument" (type);
CREATE INDEX search_doc_event_status_idx ON "SearchDocument" (type, event_status) WHERE type = 'event';
CREATE INDEX search_doc_region_idx       ON "SearchDocument" (region_code) WHERE region_code IS NOT NULL;
CREATE INDEX search_doc_starts_at_idx    ON "SearchDocument" (starts_at) WHERE type = 'event';
CREATE INDEX search_doc_org_idx          ON "SearchDocument" (org_id) WHERE org_id IS NOT NULL;
CREATE INDEX search_doc_owner_human_idx  ON "SearchDocument" (owner_human_id) WHERE owner_human_id IS NOT NULL;
CREATE INDEX search_doc_popularity_idx   ON "SearchDocument" (popularity_score DESC);
```

### Prisma schema additions

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  extensions = [pg_trgm, unaccent, cube, earthdistance]
}
```

The `SearchDocument` model itself can be partially typed in Prisma (excluding the generated columns) — the adapter falls back to `$queryRaw` for the autocomplete path where the SQL is structured around the generated columns anyway.

## Query template

The full autocomplete query is parameterised on:

| `$n` | Meaning |
|---|---|
| `$1` | raw query string (may be `''`) |
| `$2` | geo lat (or `NULL`) |
| `$3` | geo lng (or `NULL`) |
| `$4` | geo radius in meters (or `NULL`) |
| `$5` | type filter array (or `NULL`) |
| `$6` | region code array (or `NULL`) |
| `$7` | dateRange.from (timestamptz, or `NULL`) |
| `$8` | dateRange.to (timestamptz, or `NULL`) |
| `$9` | priceRange.minCents (or `NULL`) |
| `$10` | priceRange.maxCents (or `NULL`) |
| `$11` | freeOnly boolean (default `false`) |
| `$12` | tags array (or `NULL`) |
| `$13` | orgId (or `NULL`) |
| `$14` | ownerHumanId (or `NULL`) |
| `$15` | listedInDirectoryOnly boolean (default `false`) |
| `$16` | limit |
| `$17` | offset |

See plan body for the full query — kept here as a single statement so EXPLAIN ANALYZE is meaningful during tuning.

## File-by-file changes

| Path | Change |
|---|---|
| `packages/db/prisma/schema.prisma` | Enable `postgresqlExtensions`, declare the four extensions. |
| `packages/db/prisma/migrations/20260512_search_documents/migration.sql` | New migration: extensions + table + indexes. |
| `packages/adapters/src/search/multi-index-postgres-adapter.ts` | New file — implements `MultiSearchPort`. |
| `packages/adapters/src/search/__tests__/multi-index-postgres-adapter.test.ts` | Integration tests mirroring the Meili adapter test shape. |
| `packages/adapters/src/index.ts` | Export the new adapter. |
| `apps/api/src/lib/env.ts` (or local env-schema file) | Add `SEARCH_BACKEND: z.enum(["meili","postgres"]).default("meili")` and the five `SEARCH_W_*` ranking weights (`z.coerce.number().default(...)` per §D table). Same additions in `apps/jobs/src/lib/env.ts` and `apps/audio-transcoder/src/lib/env.ts` for parity. |
| `apps/api/src/lib/dep.ts:553` | Branch on `SEARCH_BACKEND` to construct the right adapter. |
| `apps/jobs/src/lib/container.ts:178` | Same branch. |
| `apps/api/src/scripts/seed/seed-data.ts:724` | Same branch. |
| `apps/api/src/routes/e2e/seed-unified-search.ts:309` | Same branch. |
| `apps/api/src/routes/e2e.ts:766` | Same branch (E2E inline construction). |
| `infra/terraform/.../prod.tfvars` (TBD path) | Flag plumbing for prod cutover. |
| `docs/decisions/postgres-search.md` | Companion ADR documenting the swap rationale (separate doc; this spec is the implementation contract). |

## Risks and tuning hooks

- **Cold-cache latency** on first query after deploy. Mitigation: the working set is small (tens of thousands of docs at projected scale) so the GIN indexes fit comfortably in RAM after the first warmup queries.
- **Trigram similarity threshold** — too low produces noise, too high kills fuzzy matches. Default 0.3 via `SELECT set_limit(0.3)`. Expose as an adapter knob (`knobs.trigramSimilarityThreshold`) for tuning without redeploy.
- **Stemming choice** — `'simple'` (proposal) avoids surprises on proper nouns; `'english'` would help recall on morphological variants. We default to `'simple'`; revisit if recall complaints surface.
- **Geo precision** — earthdistance assumes a sphere (~0.3% error). Acceptable for radius search; if precision becomes a concern we swap `geo_point` to `geometry(Point, 4326)` and the migration is the only API-visible touch.
- **Index bloat** under heavy upsert churn — the nightly full reindex rewrites every row, so bloat is naturally bounded. Schedule `VACUUM ANALYZE` weekly as a belt-and-braces.
- **Operational difference** — Meili's settings endpoint lets us hot-reload ranking rules without code. Postgres ranking lives in SQL; tweaks require a deploy. Acceptable trade for one fewer service to babysit.

## Effort and sequencing

- **Day 1:** Migration + adapter skeleton + autocomplete query + upsert/delete. Green integration tests against a local Postgres.
- **Day 2:** Container wiring, env-flag plumbing, local smoke across all consuming surfaces, ADR draft. EOD flip dev to `SEARCH_BACKEND=postgres`, watch for a day.
- **Buffer day:** Tuning (similarity threshold, popularity boost), and any port mismatches the tests surface.

Prod flip after the dev stability window. Meili teardown ~1–2 weeks later.

## Open questions

1. **Geo extension** — confirm `earthdistance` over PostGIS. PostGIS becomes attractive only if we later want map-tile work or polygon containment; for now earthdistance is leaner and Neon-friendly.
2. **Stemming** — confirm `'simple'` over `'english'`. Ithas Fire is US/EN-focused but proper nouns dominate the corpus.
3. **Single table vs per-type** — confirm the single-table choice. Per-type would only win if we later wanted radically different ranking pipelines per entity.
4. **Decommission timeline** — settled: **3 weeks** parallel operation post-prod-flip (long enough for one weekly rollup cycle + a monthly traffic spike). Cost is one Cloud Run service idling, acceptable.
