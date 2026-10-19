-- Category names in search (category-translations spec, 2026-10-16): an event
-- document carries its category's name in every language so a query for
-- "música" finds a Music event. Searchable text only (weight D of the tsvector,
-- the same rank as summary and city), never a tag or filter.
--
-- search_vector is a STORED generated column, which Postgres cannot alter, so
-- it is dropped and re-added with the extra term, and its GIN index rebuilt.
-- "SearchDocument" holds one row per searchable entity, so the rewrite is
-- small. Existing rows get an empty category_names until the next reindex
-- fills them. Single transaction (Prisma wraps the file).
ALTER TABLE "SearchDocument" ADD COLUMN "category_names" TEXT[] NOT NULL DEFAULT '{}';

DROP INDEX IF EXISTS search_doc_tsv_idx;
ALTER TABLE "SearchDocument" DROP COLUMN "search_vector";
ALTER TABLE "SearchDocument" ADD COLUMN "search_vector" TSVECTOR GENERATED ALWAYS AS (
  setweight(to_tsvector('simple'::regconfig, search_unaccent(coalesce(title,    ''))), 'A') ||
  setweight(to_tsvector('simple'::regconfig, search_unaccent(coalesce(subtitle, ''))), 'B') ||
  setweight(to_tsvector('simple'::regconfig, search_unaccent(coalesce(username, ''))), 'B') ||
  setweight(to_tsvector('simple'::regconfig, search_unaccent(coalesce(search_join_text_array(tags), ''))), 'C') ||
  setweight(to_tsvector('simple'::regconfig, search_unaccent(coalesce(summary,  ''))), 'D') ||
  setweight(to_tsvector('simple'::regconfig, search_unaccent(coalesce(city,     ''))), 'D') ||
  setweight(to_tsvector('simple'::regconfig, search_unaccent(coalesce(helper,   ''))), 'D') ||
  setweight(to_tsvector('simple'::regconfig, search_unaccent(coalesce(search_join_text_array(category_names), ''))), 'D')
) STORED;
CREATE INDEX search_doc_tsv_idx ON "SearchDocument" USING GIN (search_vector);
