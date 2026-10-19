-- Resume point for jobs that page through a table across runs.
--
-- `storage.sweep-orphaned-uploads` scans image GC candidates in pages ordered
-- by ("createdAt", "id"). Its candidate set is dominated by rows it KEEPS
-- (a referenced image is never soft-deleted, so it stays a candidate forever),
-- which means a per-run cursor always restarts at the same oldest rows and
-- anything beyond one run's page budget is never examined at all. Persisting
-- the cursor makes successive runs advance through the whole table.
ALTER TABLE "JobState" ADD COLUMN IF NOT EXISTS "cursor" JSONB;
