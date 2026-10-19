-- Non-destructive full search rebuild (2026-09-30): a per-document write
-- marker taken from the DATABASE clock at write time. The full reindex no
-- longer clears the index first; it upserts every live document (each upsert
-- sets "indexed_marker" = clock_timestamp()) and then deletes, per type, the
-- documents whose marker is older than the run's start. Existing rows get the
-- migration time, so the first rebuild after this sweeps whatever it does not
-- rewrite. Single statement. The volatile default rewrites the table once;
-- "SearchDocument" holds one row per searchable entity.
ALTER TABLE "SearchDocument" ADD COLUMN "indexed_marker" TIMESTAMPTZ(6) DEFAULT clock_timestamp();
