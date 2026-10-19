-- Image moderation — bound the degraded-requeue loop.
--
-- Adds `requeues`, a counter for how many times the degraded-requeue job has
-- sent a dead-lettered row back to PENDING.
--
-- WHY A COUNTER AND NOT JUST A RETRY WINDOW: `attempts` measures ONE retry
-- window and the requeue clears it, so it cannot bound the requeue itself. A
-- row whose R2 object no longer exists (deleted event, GC'd media) can never
-- succeed no matter how long we retry — without this column the requeue would
-- reset it, burn the full multi-day window, dead-letter, and reset again
-- forever. This happened for real: a moderation record for a deleted event was
-- manually requeued on 2026-08-20, spent its budget against a `NoSuchKey`, and
-- dead-lettered again. Once `requeues` reaches the job's cap the row stays
-- FLAGGED for a human, which is the honest terminal state for "we tried for
-- days and could not scan it".
--
-- Additive and backfill-free: NOT NULL with a DEFAULT, so every existing row
-- gets 0 and no row is rewritten by application code. Safe to apply while the
-- drain is running — an in-flight drain neither reads nor writes this column.
ALTER TABLE "image_moderation_records"
  ADD COLUMN "requeues" INTEGER NOT NULL DEFAULT 0;

-- Partial index for the requeue job's claim query
-- (`status = 'FLAGGED' AND degraded AND reviewed_at IS NULL AND requeues < N`).
-- Partial rather than composite-over-everything because the eligible set is a
-- tiny slice of the table: almost every row is APPROVED, and a FLAGGED+degraded
-- row is by definition an outage artefact. Prisma's diff engine IGNORES partial
-- indexes, so `migrate dev` will not drop this the way it drops plain SQL-only
-- indexes — same reasoning as FeePolicy_one_active_per_scope_key.
CREATE INDEX IF NOT EXISTS "image_moderation_records_requeue_candidates_idx"
  ON "image_moderation_records" ("moderated_at")
  WHERE "status" = 'FLAGGED' AND "degraded" = true AND "reviewed_at" IS NULL;
