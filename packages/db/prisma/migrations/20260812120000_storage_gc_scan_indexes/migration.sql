-- Indexes for the storage GC's candidate scan.
--
-- `sweepOrphanedUploads` pages through unreferenced-image candidates with
--   WHERE "deletedAt" IS NULL AND "createdAt" < $cutoff
--     AND ("createdAt" > $c OR ("createdAt" = $c AND "id" > $i))
--   ORDER BY "createdAt", "id" LIMIT $n
-- once PER PAGE. Before this, event_images had no index on deletedAt/createdAt
-- at all, so each page was a sequential scan plus a sort.
-- "deletedAt" leads, so this also serves the hard-delete stage's
-- `listSoftDeleted` ("deletedAt" IS NOT NULL ORDER BY "deletedAt") without a
-- second single-column index.
--
-- Deliberately NOT `CONCURRENTLY`: Prisma applies migrations inside a
-- transaction, where CONCURRENTLY is illegal. This takes a SHARE lock for the
-- build, which is fine on a table of this size — reconsider before reusing the
-- pattern on a hot table.
CREATE INDEX IF NOT EXISTS "event_images_deletedAt_createdAt_id_idx"
  ON "event_images" ("deletedAt", "createdAt", "id");
