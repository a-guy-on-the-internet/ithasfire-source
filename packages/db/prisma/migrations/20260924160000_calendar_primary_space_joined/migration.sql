-- ═══════════════════════════════════════════════════════════════════════════
-- THE PRIMARY SPACE MUST BE ONE OF THE CALENDAR'S OWN JOINED ROOMS
-- (owner ruling 2026-09-24, second half)
--
-- Migration 20260924120000_calendar_primary_space made a roomless Calendar
-- unrepresentable in one respect: `primarySpaceId` is NOT NULL and its
-- composite FK onto `Space(id, status)` — with the status leg CHECK-pinned to
-- ACTIVE — can only name a LIVE space. It did NOT say that the space is one of
-- the calendar's own `CalendarSpace` joins, and that gap RELOCATED the
-- 2026-09-23 race rather than closing it:
--
--   calendar C joined to {A, B}, primary A. T1 narrows C to {A}. T2 retires A,
--   and off its own (pre-T1) snapshot promotes C's primary to B. Both commit.
--   Every constraint holds — B is ACTIVE and is the primary — yet C's only
--   JOINED room is the retired A. C is roomless to every reader that filters
--   `calendar.spaces` by status (`get-place-booking-options`,
--   `accept-mint`'s spaceless fallback).
--
-- That residual was held shut only by WRITE ORDERING (`setSpaces` writing
-- `primarySpaceId` unconditionally so it takes the Calendar row's lock, and
-- `setSpaceStatus` re-reading AFTER its own writes). An ordering convention is
-- not an invariant: it lives in two files and any future writer can miss it.
-- The owner's instruction is that this be a DATABASE invariant. So:
--
--   FK (id, primarySpaceId) → CalendarSpace(calendarId, spaceId)
--
-- Its target is the existing `@@unique([calendarId, spaceId])`
-- ("CalendarSpace_calendarId_spaceId_key"), and because `id` is the Calendar's
-- own primary key, the FK simultaneously says "the join row belongs to THIS
-- calendar" and "its space is THIS calendar's primary". A single constraint,
-- no new column, no trigger.
--
-- ── WHY DEFERRABLE INITIALLY DEFERRED IS MANDATORY, NOT A PREFERENCE ────────
-- Calendar and CalendarSpace now reference each other
-- ("CalendarSpace_calendarId_fkey" the other way), so there is no statement
-- order that satisfies both at once when a calendar is BORN: the join row needs
-- the calendar's id, and the calendar row needs the join. `INITIALLY DEFERRED`
-- moves this FK's check to COMMIT, which is the only point at which both rows
-- exist. `CalendarsRepo.create` relies on exactly this (it inserts the Calendar
-- then its joins, inside one transaction).
--
-- CONSEQUENCE, and the thing to know before touching a seed: a DEFERRED
-- constraint is still checked at the end of the enclosing transaction, and in
-- autocommit EVERY STATEMENT IS ITS OWN TRANSACTION. Creating a Calendar and
-- its join in two separate autocommitted statements fails on the first.
-- Everything that creates a Calendar must therefore create its primary's join
-- row in the SAME transaction — the adapter always did; the seeds and the e2e
-- seed routes were changed in this commit to do so too.
--
-- ── WHAT THIS DOES NOT REPLACE ─────────────────────────────────────────────
-- The use-case guards and the write ordering STAY. They produce the friendly,
-- specific refusals a venue admin can act on
-- (`CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR` naming the blocking calendar,
-- `CALENDAR_REQUIRES_ACTIVE_SPACE`). This constraint is the backstop that
-- cannot be bypassed — including by a path that never goes through a use case.
-- Two layers, different jobs.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. FAIL LOUDLY on any Calendar whose primary is not among its own joins.
--
-- Deliberately NOT repaired here, same posture as 20260924120000's backfill
-- check. Attaching the primary's join row would be the obvious guess and is
-- the wrong one: a primary that drifted off the join set is evidence of a
-- write that raced, and which of the two rows is correct (join the primary? or
-- repoint the primary at a room the calendar actually serves?) is a judgement
-- about what the venue meant. A migration that guessed would destroy the
-- evidence and could attach a room the venue deliberately un-joined.
--
-- Dev is clean: 0 of 19 calendars offend as of 2026-09-24.
DO $$
DECLARE
  offender_count integer;
  offenders text;
BEGIN
  SELECT count(*), string_agg(
           format('%s (%L, primarySpaceId=%s)', c."id", c."name", c."primarySpaceId"),
           ', ' ORDER BY c."id")
    INTO offender_count, offenders
  FROM "Calendar" c
  WHERE NOT EXISTS (
    SELECT 1
    FROM "CalendarSpace" cs
    WHERE cs."calendarId" = c."id"
      AND cs."spaceId" = c."primarySpaceId"
  );

  IF offender_count > 0 THEN
    RAISE EXCEPTION
      'Calendar.primarySpaceId is not a joined space on % calendar(s): %',
      offender_count, offenders
      USING HINT =
        'For each listed calendar, decide which row is right: attach the primary as a CalendarSpace join, or repoint primarySpaceId at an ACTIVE space the calendar already serves. Then re-run this migration. Do NOT point primarySpaceId at a RETIRED space — "Calendar_primary_space_active_check" (migration 20260924120000) rejects it.';
  END IF;
END $$;

-- ── 2. The constraint.
--
-- DECLARED IN PRISMA TOO (`Calendar.primaryJoin`, venue.prisma) with an
-- explicit `map:` so Prisma owns the NAME. That is load-bearing rather than
-- cosmetic: VERIFIED with `prisma migrate diff` that a schema which does NOT
-- declare it emits `ALTER TABLE "Calendar" DROP CONSTRAINT
-- "Calendar_primary_space_joined_fkey"` — i.e. left SQL-only, the next
-- `db push` would silently delete the invariant. Also VERIFIED that Prisma's
-- differ reads the DEFERRABLE form in the database as satisfying the
-- (non-deferrable) declaration, so `db push` against an existing database is a
-- no-op here and will not quietly de-deferrablise it.
--
-- Prisma CANNOT express DEFERRABLE (prisma/prisma#8807); its introspection only
-- flags the model with "constraints using non-default deferring rules". So the
-- DDL is hand-written here, and a from-scratch `prisma db push` / `migrate dev`
-- would create this FK NON-deferrable. That failure is LOUD and immediate —
-- every calendar create breaks — not silent. `prisma migrate deploy`, which is
-- how every real database is built, runs this file.
--
-- NO ACTION on both sides matches what Prisma renders, and is what keeps
-- cascades working: deleting a Place cascades its Calendars, Spaces and
-- CalendarSpace rows, and a deferred NO ACTION check at commit finds the
-- referencing Calendar row already gone.
ALTER TABLE "Calendar"
  ADD CONSTRAINT "Calendar_primary_space_joined_fkey"
  FOREIGN KEY ("id", "primarySpaceId")
  REFERENCES "CalendarSpace"("calendarId", "spaceId")
  ON DELETE NO ACTION ON UPDATE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;
