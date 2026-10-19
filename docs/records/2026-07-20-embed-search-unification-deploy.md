# Deploy runbook — Embed → Search unification + event visibility gate

**Status:** built + reviewed, UNCOMMITTED (worktree). Not yet deployed.
**Backend:** prod + dev both run `SEARCH_BACKEND=postgres`, `enable_meilisearch=false` (retired). The Meilisearch adapter is dead infra — no `ensureIndexes()` / filterable-attribute step applies.

## What shipped
- Event search docs now carry `isPublic` (from `Event.visibility`; PUBLIC→true, PRIVATE→false), `endsAt`, `city` (from locality), `addressText` (redacted public address), and `placeId`.
- Both search adapters gate events on `is_public` for public queries — a **fail-closed, owner-scoped** bypass (`includeNonPublicEvents`) is honored ONLY for the authed admin autocomplete. This fixes a PRIVATE-event leak in **both** the embed and main site search.
- `unifiedSearch` gained `placeIds` + category(`tags`) filters and returns the full event render payload.
- The embed widget's event lists (`get-embed-calendar-events`, `get-embed-for-widget`) now call `unifiedSearch` — the embed uses the same query as the platform. Ownership resolution (`places.listOwnedBySubject`) stays in Postgres (authz).
- `indexEventsByIds` is now **upsert-or-delete**: cancel/unpublish/delete-event and hero-moderation decisions promptly remove/refresh the doc (previously lingered until nightly).

## Migrations (additive, safe)
1. `SearchDocument` add `ends_at`, `address_text` (nullable — metadata-only, no rewrite).
2. `PlaceOwnership` add `@@index([ownerType, ownerId])` — `CREATE INDEX CONCURRENTLY` (backs the public embed venue lookup).
   - Dev is db-push-managed (`prisma db push` / psql). Prod via normal migrate-deploy.

## ⚠️ DEPLOY ORDERING — the one real footgun
The visibility gate filters `is_public = TRUE`. Existing search docs (written before this code) have `is_public = false` (the column default). **So between the moment the gate code goes live and the moment a full reindex finishes, public search + embeds return ~ZERO events** (every event gated out until its doc is re-stamped).

The gate and the new indexer ship in the same build, so the gate is active from deploy. Minimize the window:

1. Deploy the code **off-peak**.
2. Apply the migrations.
3. **Immediately** run a full reindex — this re-stamps every doc with `is_public`, the render fields, and `place_id`:
   ```
   pnpm -F api reindex:search        # SEARCH_BACKEND=postgres (default)
   ```
4. Verify: a public search / embed returns PUBLIC events, and a known PRIVATE event does NOT appear.

During steps 1→3 (a few minutes at current scale) search under-returns. New/edited events self-heal via `reindexAfterMutation`; the backfill is only needed for pre-existing docs. The nightly `search.full-reindex` (03:00 UTC) is the standing reconcile backstop.

> If a zero-window cutover is ever required (higher traffic): split into two deploys — ship the indexer changes WITHOUT the gate, run the reindex, then ship the gate in a follow-up. Not necessary at current scale.

## Rollback
Revert the code. The added columns/index are additive and harmless if unused; leave them. Re-run `reindex:search` if the doc shape needs to match the reverted code.

## Post-deploy sanity
- Public `/search`: PRIVATE events absent (this also closes the pre-existing main-search leak).
- Admin autocomplete (owner-scoped): own PRIVATE events still visible.
- Embed calendar/widget on an allowlisted domain: renders PUBLIC events with dates/location; cancel an event → gone within seconds (was ≤24h).

## Known follow-ups (non-blocking)
- Calendar ordering at scale: legs fetched by relevance then re-sorted by date, so a subject with >200 upcoming events could drop least-popular ones regardless of date (gaps mid-window, not just tail). Logged, not silent. Fix = date-ordered fetch for the embed leg. Irrelevant at Nashville scale.
- Meili adapter kept in lockstep throughout but is retired infra; if ever re-enabled, `ensureIndexes()` must run so `isPublic`/`placeId` are filterable before the gate serves traffic.
