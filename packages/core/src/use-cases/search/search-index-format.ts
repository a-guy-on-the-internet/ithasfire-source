/**
 * The version of the search DOCUMENT FORMAT this build writes.
 *
 * Bump it in the same change that alters what a document holds in a way old
 * documents cannot satisfy: a new column the read side depends on, a changed
 * projection, a renamed id. After the next deploy has rolled the jobs
 * service, the deploy workflow fires `search.ensure-format` once; that job
 * (`ensureSearchIndexFormat`, the same code that rebuilds) sees the stored
 * version (`SearchIndexState.formatVersion`) is behind, claims, runs ONE
 * non-destructive full reindex and records the version when no page failed.
 * The nightly `search.full-reindex` records it too, so a missed trigger
 * catches up by the next night.
 *
 * History:
 *   1 — implicit: everything before this constant existed.
 *   2 — 21fb8b51 (2026-09-28): `location_is_exact` + `location_radius_meters`
 *       on SearchDocument. Rows indexed before it default to "not exact", so
 *       the map drew no pins until the nightly rebuild.
 *   3 — (2026-10-15): the Minneapolis 3% entertainment tax joins the stored
 *       lowest all-in price. Rows indexed before it show a total without it.
 *   4 — (2026-10-15): `timezone` on SearchDocument. Rows indexed before it
 *       stamp in the platform default, so a Pacific show's card read a
 *       Central time beside a date formatted in Pacific.
 *   (no bump, 2026-10-16): `category_names` needed none. English names are
 *       already findable through the category slug tag, the Spanish names are
 *       new, and setting or renaming a category marks its events for reindex.
 */
export const SEARCH_INDEX_FORMAT_VERSION = 4;
