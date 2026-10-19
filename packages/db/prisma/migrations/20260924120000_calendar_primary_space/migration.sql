-- ═══════════════════════════════════════════════════════════════════════════
-- THE ≥1-ACTIVE-SPACE-PER-CALENDAR INVARIANT BECOMES A DATABASE CONSTRAINT
-- (owner ruling 2026-09-24)
--
-- Before this migration the rule lived only in application code
-- (packages/core/src/use-cases/places/_shared/calendar-active-space.ts),
-- serialized by a cooperative `pg_advisory_xact_lock`
-- (`SpacesRepo.lockCalendarSpaceGuard`). A caller that forgot the lock, or any
-- write path outside those three use cases, could strand a calendar with no
-- room to schedule into. This makes a roomless Calendar UNREPRESENTABLE:
--
--   Calendar.primarySpaceId  NOT NULL
--   Calendar.primarySpaceStatus  pinned to 'ACTIVE' by a CHECK
--   composite FK (primarySpaceId, primarySpaceStatus) → Space(id, status)
--
-- The FK can therefore only be satisfied by a Space row whose status is
-- literally ACTIVE. Retiring a referenced Space fails the FK, and because FK
-- checks take real row locks, a concurrent retire BLOCKS behind an uncommitted
-- repoint instead of racing it. The advisory lock is deleted in the same
-- change.
--
-- ORDER MATTERS: add the column nullable → backfill → verify → SET NOT NULL →
-- constraints. Adding it NOT NULL up front is impossible (no sane default).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The FK's target. A composite FK needs a unique key to reference; (id)
-- alone would not carry the status, which is the whole point. Named the way
-- Prisma's `@@unique([id, status])` on Space names it, so `migrate diff` stays
-- silent.
CREATE UNIQUE INDEX "Space_id_status_key" ON "Space"("id", "status");

-- ── 2. Columns, nullable for now.
-- `primarySpaceStatus` is NOT NULL from the start: it has a default and the
-- CHECK below makes 'ACTIVE' the only value it can ever hold, so there is
-- nothing to backfill.
ALTER TABLE "Calendar"
  ADD COLUMN "primarySpaceId" TEXT,
  ADD COLUMN "primarySpaceStatus" "SpaceStatus" NOT NULL DEFAULT 'ACTIVE';

-- ── 3. Backfill: each Calendar's primary is its LOWEST-sortOrder ACTIVE
-- joined Space.
--
-- The tie-break mirrors what the application would already have picked, so the
-- primary agrees with the space every existing reader resolves to:
-- `CalendarsRepo.listByPlace` hydrates `spaces` ordered by (sortOrder asc,
-- createdAt asc) and both `accept-mint`'s spaceless fallback
-- (`spaces.find(s => s.status === "ACTIVE")`) and
-- `get-place-booking-options` take the first ACTIVE one off that list. `s.id`
-- is appended purely to make the choice deterministic when sortOrder AND
-- createdAt collide — a same-millisecond seed, which the dev fixtures produce.
UPDATE "Calendar" c
SET "primarySpaceId" = pick."spaceId"
FROM (
  SELECT DISTINCT ON (cs."calendarId") cs."calendarId", cs."spaceId"
  FROM "CalendarSpace" cs
  JOIN "Space" s ON s."id" = cs."spaceId"
  WHERE s."status" = 'ACTIVE'
  ORDER BY cs."calendarId", s."sortOrder" ASC, s."createdAt" ASC, s."id" ASC
) AS pick
WHERE pick."calendarId" = c."id";

-- ── 4. FAIL LOUDLY on any Calendar the backfill could not serve.
--
-- Deliberately NOT repaired here. A calendar with no ACTIVE joined space is a
-- venue whose rooms need a human decision (attach which room? reactivate a
-- retired one? delete the calendar?), and a migration that guessed — or that
-- quietly backfilled a RETIRED space to satisfy itself — would both lie to the
-- CHECK and destroy the evidence. Dev is clean (0 roomless calendars as of
-- 2026-09-24); production may differ, and that is the owner's call to make,
-- not this file's.
DO $$
DECLARE
  offender_count integer;
  offenders text;
BEGIN
  SELECT count(*), string_agg(format('%s (%L)', c."id", c."name"), ', ' ORDER BY c."id")
    INTO offender_count, offenders
  FROM "Calendar" c
  WHERE c."primarySpaceId" IS NULL;

  IF offender_count > 0 THEN
    RAISE EXCEPTION
      'Calendar.primarySpaceId backfill incomplete: % calendar(s) have no ACTIVE joined Space: %',
      offender_count, offenders
      USING HINT =
        'Attach an ACTIVE Space to each listed calendar (or reactivate one of its retired rooms, or delete the calendar) and re-run this migration. Do NOT point primarySpaceId at a RETIRED space: the CHECK constraint this migration adds would reject it.';
  END IF;
END $$;

-- ── 5. Lock it in.
ALTER TABLE "Calendar" ALTER COLUMN "primarySpaceId" SET NOT NULL;

-- SQL-ONLY (Prisma cannot express CHECK constraints — same posture as
-- "BookingRequest_intent_shape_check"). This is the piece that turns the FK
-- from "references some Space" into "references an ACTIVE Space". Without it
-- the FK is satisfiable by a retired room and the invariant is decorative.
ALTER TABLE "Calendar"
  ADD CONSTRAINT "Calendar_primary_space_active_check"
  CHECK ("primarySpaceStatus" = 'ACTIVE');

-- NO ACTION on both sides, deliberately:
--   * onUpdate CASCADE would propagate a retire into "primarySpaceStatus" and
--     surface as the CHECK failing rather than the FK — a worse error and a
--     worse story for the venue admin.
--   * NO ACTION rather than RESTRICT is what keeps `DELETE FROM "Place"`
--     working: NO ACTION is checked at END of statement, by which time the
--     cascade has removed the Calendar rows too. RESTRICT is checked
--     immediately and would break place deletion.
ALTER TABLE "Calendar"
  ADD CONSTRAINT "Calendar_primarySpaceId_primarySpaceStatus_fkey"
  FOREIGN KEY ("primarySpaceId", "primarySpaceStatus")
  REFERENCES "Space"("id", "status")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
