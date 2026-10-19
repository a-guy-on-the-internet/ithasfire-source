# Deploy runbook — search map: venues layer + approximate areas

**Change:** `/search` draws venues (squares) beside events (dots) on one map, and draws any
approximate location — venue or event — as a circle at its published radius instead of a pin.
Backend: `SEARCH_BACKEND=postgres` in dev and prod.

## Migrations (additive, metadata-only)
1. `20260928140000_search_document_location_is_exact` — `SearchDocument.location_is_exact BOOLEAN NOT NULL DEFAULT false`.
2. `20260928140001_search_document_location_radius_meters` — `SearchDocument.location_radius_meters INTEGER` (nullable).

Both run in `migrate_db` before the services roll. Neither rewrites the table.

## ⚠️ Run `search.full-reindex` RIGHT AFTER this deploy

Existing search rows get the column defaults (not exact, no radius). The new code fails closed on
them, so **until a full reindex rewrites every row**:

- venues from old rows are **not drawn** on the map;
- events from old rows draw as small soft "approximate" rings, not pins;
- nothing is mis-drawn as a pin. One exception to the "private" count: an EXACT venue that was never
  geocoded, on a row written before this deploy, reads as private (not exact, no position) until the
  reindex rewrites its row as exact.

No deploy step reindexes venues (the fee-policy seed reindexes events only, and only when it writes a
change), and the nightly run is up to ~24h away. So, once `deploy_prod` / `deploy_dev` is green:

- **Deployed environment:** trigger the scheduler job for `search.full-reindex` on the jobs service:
  ```
  gcloud scheduler jobs list --location "$REGION" --filter="name~search-full-reindex"
  gcloud scheduler jobs run <that-job-name> --location "$REGION"
  ```
- **Locally:** `pnpm -F api reindex:search`

A full reindex deletes and rebuilds each document type, so search is briefly thin while it runs.

## Verify
- `/search?type=place` shows a map; an EXACT venue is a square, a venue that withholds its address
  but publishes an area (e.g. dev's Fishbowl House, Nashville) is a shaded dashed circle.
- A search payload's place suggestions carry `lat`, `lng`, `locationIsExact`,
  `locationRadiusMeters`, `locationHidden`; an OBSCURED venue's `lat`/`lng` is its keyed circle
  centre, never its stored point.

## Known follow-up (not built)
If a venue flips EXACT → withheld and its targeted place reindex FAILS, its old document keeps the
exact pin until the next successful reindex (at worst the nightly run). `upsertPlace` →
`reindexAfterMutation` reports that failure (`reportError`) but does not retry it; closing the gap
needs a retry or a durable reindex outbox for places.
