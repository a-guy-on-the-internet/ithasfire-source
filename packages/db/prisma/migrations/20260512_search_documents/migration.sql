CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;

CREATE OR REPLACE FUNCTION search_unaccent(input text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
BEGIN
  RETURN unaccent('public.unaccent', input);
END;
$$;

CREATE OR REPLACE FUNCTION search_join_text_array(input text[])
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
BEGIN
  RETURN array_to_string(input, ' ');
END;
$$;

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
    setweight(to_tsvector('simple'::regconfig, search_unaccent(coalesce(title,    ''))), 'A') ||
    setweight(to_tsvector('simple'::regconfig, search_unaccent(coalesce(subtitle, ''))), 'B') ||
    setweight(to_tsvector('simple'::regconfig, search_unaccent(coalesce(username, ''))), 'B') ||
    setweight(to_tsvector('simple'::regconfig, search_unaccent(coalesce(search_join_text_array(tags), ''))), 'C') ||
    setweight(to_tsvector('simple'::regconfig, search_unaccent(coalesce(summary,  ''))), 'D') ||
    setweight(to_tsvector('simple'::regconfig, search_unaccent(coalesce(city,     ''))), 'D') ||
    setweight(to_tsvector('simple'::regconfig, search_unaccent(coalesce(helper,   ''))), 'D')
  ) STORED,

  trigram_corpus TEXT GENERATED ALWAYS AS (
    search_unaccent(coalesce(title,'') || ' ' || coalesce(subtitle,'') || ' ' || coalesce(username,''))
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